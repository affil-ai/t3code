import {
  CommandId,
  FirstmateError,
  MessageId,
  type OrchestrationV2ThreadShell,
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
import {
  mergeWakes,
  parseWakeDigest,
  WAKE_MESSAGE_PREFIX,
  wakeDigest,
  wakeNotification,
  type FirstmateWake,
  type FirstmateWakeReason,
} from "./wakeDigest.ts";

const SWEEP_INTERVAL = "30 seconds";
// Domain events arrive in bursts while threads stream; one sweep per burst is enough.
const EVENT_DEBOUNCE = "1 second";
const ORPHAN_AFTER_MS = 10 * 60_000;

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

export {
  mergeWakes,
  parseWakeDigest,
  wakeDigest,
  wakeNotification,
  type FirstmateWake,
  type FirstmateWakeReason,
} from "./wakeDigest.ts";

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
  type Coordinator = FirstmateService.AgentCoordinator & {
    readonly shell: OrchestrationV2ThreadShell;
  };
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
          : {
              runId: run.id,
              held: run.queueHeld === true,
              // Whether a turn is in flight, which would queue a new wake behind it.
              busy: projection.runs.some(
                (candidate) =>
                  candidate.status === "preparing" ||
                  candidate.status === "starting" ||
                  candidate.status === "running" ||
                  candidate.status === "waiting",
              ),
              wakes: parseWakeDigest(message.text),
            };
      }),
    );

  /** Sends one agent's wakes to its coordinator chat, folding into a queued wake. */
  const deliver = (
    target: ThreadId,
    projectId: ProjectId,
    wakes: ReadonlyArray<FirstmateWake>,
  ) =>
    Effect.gen(function* () {
      const pending = yield* pendingWake(projectId, target);
      // A restart or stop holds the coordinator's queue until someone resumes it,
      // and a wake folded into a held run never reaches the coordinator. Once no
      // turn is in flight, send the held digest again as a new wake and drop the
      // held one. While a turn runs, a new wake would queue behind it and be held
      // too, so the wake keeps folding into the held run until that turn ends.
      if (pending?.held === true && !pending.busy) {
        const wakeId = yield* crypto.randomUUIDv4;
        const merged = mergeWakes(pending.wakes, wakes);
        // With nothing in flight the wake starts a turn; the held queue only blocks
        // queued sends. Sending before cancelling means a failure between the two
        // repeats the wake rather than losing it.
        yield* threads.sendToThread({
          projectId,
          commandId: CommandId.make(`firstmate:wake:${wakeId}`),
          threadId: target,
          messageId: MessageId.make(`${WAKE_MESSAGE_PREFIX}${wakeId}`),
          text: wakeDigest(merged),
          notification: wakeNotification(merged),
          attachments: [],
          mode: "auto",
          createdBy: "agent",
          creationSource: "server",
        });
        yield* threads.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`firstmate:wake-cancel-held:${wakeId}`),
          threadId: target,
          runId: pending.runId,
        });
      } else if (wakes.length > 0) {
        const wakeId = yield* crypto.randomUUIDv4;
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
            projectId,
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
    });

  const sweep = () =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        // Each agent's open tasks wake that agent's chat; an agent whose chat is
        // gone, or that has none, is skipped and its tasks wait.
        const coordinators = yield* firstmate.coordinators();
        if (coordinators.length === 0) return;
        const shells = new Map<string, Coordinator>();
        for (const coordinator of coordinators) {
          const shell = yield* threads.getThreadShell(coordinator.threadId);
          if (shell !== null) shells.set(coordinator.agentId, { ...coordinator, shell });
        }
        if (shells.size === 0) return;
        const tasks = yield* firstmate.listStored();
        const now = yield* Clock.currentTimeMillis;
        const previouslySeen = yield* Ref.get(seen);
        const activeKeys = new Set<string>();
        const wakesByAgent = new Map<string, FirstmateWake[]>();
        const acknowledgements: Effect.Effect<void, FirstmateError>[] = [];
        for (const task of tasks) {
          // Defensive even when listStored's default query excludes closed tasks.
          if (task.state === "done" || task.state === "dropped") continue;
          if (!shells.has(task.agentId)) continue;
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
            const wakes = wakesByAgent.get(task.agentId) ?? [];
            wakes.push({
              taskId: String(task.id),
              title: task.title,
              reason: taskReasons[0]!,
              additionalReasons: taskReasons.slice(1),
              ...(worker?.latestRunId == null ? {} : { runId: String(worker.latestRunId) }),
            });
            wakesByAgent.set(task.agentId, wakes);
          }
        }
        for (const { agentId, threadId, shell } of shells.values()) {
          yield* deliver(threadId, shell.projectId, wakesByAgent.get(agentId) ?? []);
        }
        // Markers are saved only after the enqueue succeeds. A failed send fails
        // this pass before here, so the next pass reports the same wakes again.
        // Dropping inactive time/request keys keeps memory bounded and lets a
        // later wait notify again.
        yield* Ref.set(seen, activeKeys);
        yield* Effect.all(acknowledgements, { discard: true });
      }).pipe(
        Effect.mapError(
          (cause) => new FirstmateError({ message: "Could not send the agent wake.", cause }),
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
