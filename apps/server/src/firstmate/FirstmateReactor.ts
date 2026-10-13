import {
  CommandId,
  FirstmateError,
  MessageId,
  type OrchestrationV2Notification,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as FirstmateService from "./FirstmateService.ts";

const SWEEP_INTERVAL = "30 seconds";
// Domain events arrive in bursts while threads stream; one sweep per burst is enough.
const EVENT_DEBOUNCE = "1 second";
const ORPHAN_AFTER_MS = 10 * 60_000;

export type FirstmateWakeReason =
  | "worker-completed"
  | "worker-failed"
  | "worker-interrupted"
  | "worker-waiting"
  | "wake-time"
  | "orphan";

export interface FirstmateWake {
  readonly taskId: string;
  readonly title: string;
  readonly reason: FirstmateWakeReason;
  readonly additionalReasons?: ReadonlyArray<FirstmateWakeReason>;
  readonly runId?: string;
}

const terminalReason = (status: string): FirstmateWakeReason | undefined => {
  switch (status) {
    case "completed":
      return "worker-completed";
    case "failed":
      return "worker-failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "worker-interrupted";
    default:
      return undefined;
  }
};

export function wakeDigest(wakes: ReadonlyArray<FirstmateWake>): string {
  return [
    "Firstmate wake-up:",
    ...wakes.map(
      (wake) =>
        `- ${wake.taskId} ${wake.title}: ${[wake.reason, ...(wake.additionalReasons ?? [])].join(", ")}`,
    ),
    "",
    "Reconcile with firstmate_task_list, update every task you touch, and tell the user only about outcomes and decisions.",
  ].join("\n");
}

const WAKE_REASON_LABELS: Record<FirstmateWakeReason, string> = {
  "worker-completed": "worker finished",
  "worker-failed": "worker failed",
  "worker-interrupted": "worker stopped",
  "worker-waiting": "worker needs input",
  "wake-time": "check-in time",
  orphan: "no worker running",
};

// Enough to tell the tasks apart in a one-line row; the full digest is the message text.
const SUMMARY_TASKS = 3;
const SUMMARY_TITLE_LENGTH = 40;

function shortTitle(title: string): string {
  return title.length <= SUMMARY_TITLE_LENGTH
    ? title
    : `${title.slice(0, SUMMARY_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * The compact timeline row for a wake. The coordinator still receives the
 * full digest as the message text; this is what the user sees.
 */
export function wakeNotification(wakes: ReadonlyArray<FirstmateWake>): OrchestrationV2Notification {
  const reasons = new Set(
    wakes.flatMap((wake) => [wake.reason, ...(wake.additionalReasons ?? [])]),
  );
  const outcome = reasons.has("worker-failed")
    ? "failed"
    : reasons.has("worker-waiting")
      ? "updated"
      : "completed";
  const items = wakes
    .slice(0, SUMMARY_TASKS)
    .map((wake) => `${shortTitle(wake.title)} (${WAKE_REASON_LABELS[wake.reason]})`);
  const more = wakes.length - items.length;
  const count = wakes.length === 1 ? "1 update" : `${wakes.length} updates`;
  return {
    source: { kind: "monitor" },
    outcome,
    summary: `Firstmate: ${count} — ${items.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
    // Expanding the row shows the same digest the coordinator received.
    detail: wakeDigest(wakes),
  };
}

const WAKE_MESSAGE_PREFIX = "firstmate:wake-message:";
const WAKE_REASONS: ReadonlySet<string> = new Set<FirstmateWakeReason>([
  "worker-completed",
  "worker-failed",
  "worker-interrupted",
  "worker-waiting",
  "wake-time",
  "orphan",
]);

/**
 * Reads the task lines back out of a digest written by `wakeDigest`, so a
 * queued wake can be folded into without the reactor remembering it, even
 * across a restart. Run ids are not in the digest.
 */
export function parseWakeDigest(text: string): ReadonlyArray<FirstmateWake> {
  return text.split("\n").flatMap((line) => {
    const match = /^- (\S+) (.+): ([a-z-]+(?:, [a-z-]+)*)$/.exec(line);
    if (match === null) return [];
    const reasons = match[3]!.split(", ");
    if (!reasons.every((reason) => WAKE_REASONS.has(reason))) return [];
    const [reason, ...additionalReasons] = reasons as FirstmateWakeReason[];
    return [{ taskId: match[1]!, title: match[2]!, reason: reason!, additionalReasons }];
  });
}

/**
 * Folds `next` into `pending`: one line per task, reasons combined in the
 * order first seen, and the newest run id. Tasks keep their first position.
 */
export function mergeWakes(
  pending: ReadonlyArray<FirstmateWake>,
  next: ReadonlyArray<FirstmateWake>,
): ReadonlyArray<FirstmateWake> {
  const merged = new Map<string, FirstmateWake>();
  for (const wake of [...pending, ...next]) {
    const existing = merged.get(wake.taskId);
    if (existing === undefined) {
      merged.set(wake.taskId, wake);
      continue;
    }
    const reasons = [
      ...new Set([
        existing.reason,
        ...(existing.additionalReasons ?? []),
        wake.reason,
        ...(wake.additionalReasons ?? []),
      ]),
    ];
    merged.set(wake.taskId, {
      taskId: wake.taskId,
      title: wake.title,
      reason: reasons[0]!,
      additionalReasons: reasons.slice(1),
      ...((wake.runId ?? existing.runId) === undefined
        ? {}
        : { runId: wake.runId ?? existing.runId }),
    });
  }
  return [...merged.values()];
}

export class FirstmateReactor extends Context.Service<
  FirstmateReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sweep: () => Effect.Effect<void, FirstmateError>;
  }
>()("t3/firstmate/FirstmateReactor") {}

const make = Effect.gen(function* () {
  const firstmate = yield* FirstmateService.FirstmateService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const crypto = yield* Crypto.Crypto;
  const signal = yield* PubSub.sliding<void>(1);
  const seen = yield* Ref.make<ReadonlySet<string>>(new Set());
  const lane = yield* Semaphore.make(1);
  /** The coordinator's queued Firstmate wake that has not started, if any. */
  const pendingWake = (projectId: ProjectId, threadId: ThreadId) =>
    threads.getProjectThreadRecords({ projectId, threadId }, ["runs", "messages"]).pipe(
      Effect.map((projection) => {
        const run = projection.runs.find(
          (candidate) =>
            candidate.status === "queued" &&
            candidate.userMessageId.startsWith(WAKE_MESSAGE_PREFIX),
        );
        const message =
          run === undefined
            ? undefined
            : projection.messages.find((candidate) => candidate.id === run.userMessageId);
        return run === undefined || message === undefined
          ? undefined
          : { runId: run.id, wakes: parseWakeDigest(message.text) };
      }),
    );

  const sweep = () =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        const target = yield* firstmate.coordinatorThreadId();
        if (target === null) return;
        const coordinatorShell = yield* threads.getThreadShell(target);
        if (coordinatorShell === null) return;
        const tasks = yield* firstmate.listStored();
        const now = yield* Clock.currentTimeMillis;
        const previouslySeen = yield* Ref.get(seen);
        const activeKeys = new Set<string>();
        const wakes: FirstmateWake[] = [];
        const acknowledgements: Effect.Effect<void, FirstmateError>[] = [];
        for (const task of tasks) {
          // Defensive even when listStored's default query excludes closed tasks.
          if (task.state === "done" || task.state === "dropped") continue;
          const taskReasons: FirstmateWakeReason[] = [];
          const worker =
            task.workerThreadId === null
              ? null
              : yield* threads.getThreadShell(task.workerThreadId);
          if (task.wakeAt !== null && Date.parse(task.wakeAt) <= now) {
            const key = `${task.id}:wake:${task.wakeAt}`;
            activeKeys.add(key);
            if (!previouslySeen.has(key)) taskReasons.push("wake-time");
          }
          if (worker !== null) {
            const reason = terminalReason(worker.status);
            if (
              reason !== undefined &&
              worker.latestRunId !== null &&
              worker.latestRunId !== task.lastReportedRunId
            ) {
              taskReasons.push(reason);
              acknowledgements.push(firstmate.markReportedRun(task.id, String(worker.latestRunId)));
            }
            if (worker.status === "waiting" || worker.pendingRuntimeRequest !== null) {
              // A second request in the same run deserves a fresh notification.
              const key = `${task.id}:waiting:${task.workerThreadId}:${worker.pendingRuntimeRequest?.id ?? worker.latestRunId}`;
              activeKeys.add(key);
              if (!previouslySeen.has(key)) taskReasons.push("worker-waiting");
            }
          }
          // A detached task, a missing worker thread, and a worker whose latest
          // run has ended all count as having no running worker.
          const hasRunningWorker =
            worker !== null &&
            (worker.activeRunId !== null ||
              worker.status === "preparing" ||
              worker.status === "queued" ||
              worker.status === "starting" ||
              worker.status === "running" ||
              worker.status === "waiting");
          const age = now - Date.parse(task.updatedAt);
          if (
            task.state === "open" &&
            task.wakeAt === null &&
            (task.nextActor === "coordinator" || task.nextActor === "worker") &&
            !hasRunningWorker &&
            age >= ORPHAN_AFTER_MS &&
            task.orphanNotifiedAt === null
          ) {
            taskReasons.push("orphan");
            acknowledgements.push(
              firstmate.markOrphanNotified(task.id, DateTime.formatIso(DateTime.makeUnsafe(now))),
            );
          }
          // One line per task, even when more than one condition triggered the pass.
          if (taskReasons.length > 0) {
            wakes.push({
              taskId: String(task.id),
              title: task.title,
              reason: taskReasons[0]!,
              additionalReasons: taskReasons.slice(1),
              ...(worker?.latestRunId == null ? {} : { runId: String(worker.latestRunId) }),
            });
          }
        }
        if (wakes.length > 0) {
          const wakeId = yield* crypto.randomUUIDv4;
          const pending = yield* pendingWake(coordinatorShell.projectId, target);
          if (pending !== undefined) {
            // At most one wake waits: fold this pass into the one already queued.
            const merged = mergeWakes(pending.wakes, wakes);
            yield* threads.dispatch({
              type: "queued-notification.revise",
              commandId: CommandId.make(`firstmate:wake-revise:${wakeId}`),
              threadId: target,
              runId: pending.runId,
              text: wakeDigest(merged),
              notification: wakeNotification(merged),
            });
          } else {
            // `auto` steers the wake into the coordinator's active turn when it can,
            // so a failure is seen mid-conversation instead of behind the user's turns.
            yield* threads.sendToThread({
              projectId: coordinatorShell.projectId,
              commandId: CommandId.make(`firstmate:wake:${wakeId}`),
              threadId: target,
              messageId: MessageId.make(`${WAKE_MESSAGE_PREFIX}${wakeId}`),
              text: wakeDigest(wakes),
              // A notification is an automatic wake: a compact row in the timeline,
              // hidden from the queue, and it does not keep the thread from settling.
              notification: wakeNotification(wakes),
              attachments: [],
              mode: "auto",
              createdBy: "agent",
              creationSource: "server",
            });
          }
        }
        // Markers are saved only after the enqueue succeeds. A failed send fails
        // this pass before here, so the next pass reports the same wakes again.
        // Dropping inactive time/request keys keeps memory bounded and lets a
        // later wait notify again.
        yield* Ref.set(seen, activeKeys);
        yield* Effect.all(acknowledgements, { discard: true });
      }).pipe(
        Effect.mapError(
          (cause) => new FirstmateError({ message: "Could not send the Firstmate wake.", cause }),
        ),
      ),
    );

  const start = () =>
    Effect.gen(function* () {
      const events = yield* Effect.forkScoped(
        orchestrator.streamDomainEvents.pipe(
          Stream.runForEach(() => PubSub.publish(signal, undefined).pipe(Effect.ignore)),
          Effect.catchCause((cause) =>
            Effect.logWarning("Firstmate event wake stream stopped", { cause }),
          ),
        ),
      );
      yield* forkParked(
        Stream.merge(
          Stream.fromSchedule(Schedule.spaced(SWEEP_INTERVAL)),
          Stream.fromSubscription(yield* PubSub.subscribe(signal)).pipe(
            Stream.debounce(EVENT_DEBOUNCE),
          ),
        ).pipe(
          Stream.runForEach(() =>
            sweep().pipe(
              Effect.catchCause((cause) => Effect.logWarning("Firstmate sweep failed", { cause })),
            ),
          ),
          Effect.ensuring(Fiber.interrupt(events)),
        ),
      );
    });

  return { start, sweep } satisfies FirstmateReactor["Service"];
});

export const reactorLayer = Layer.effect(FirstmateReactor, make);
