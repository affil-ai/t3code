import {
  CommandId,
  FirstmateError,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
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

const terminalReason = (status: OrchestrationV2Run["status"]): FirstmateWakeReason | undefined => {
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

const isCoordinatorInput = (message: {
  readonly createdBy: string;
  readonly creationSource: string;
}): boolean =>
  message.creationSource === "web" ||
  (message.createdBy === "agent" && message.creationSource === "mcp");

/** Monitor news needs attention even while the worker keeps watching. Passed checks do not. */
const isActionableMonitorNotice = (message: OrchestrationV2ConversationMessage | null): boolean =>
  message?.createdBy === "agent" &&
  message.creationSource === "server" &&
  message.notification?.source.kind === "monitor" &&
  (message.notification.outcome === "updated" || message.notification.outcome === "failed");

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

  const terminalRunsAfter = Effect.fn("FirstmateReactor.terminalRunsAfter")(function* (
    worker: OrchestrationV2ThreadShell,
    markerId: string | null,
    terminalNoticeMarkerId: string | null,
  ) {
    // Held completions keep the marker behind them, so equality means nothing is pending.
    if (worker.latestRunId === markerId) return [];
    const target = { projectId: worker.projectId, threadId: worker.id };
    const { runs } = yield* threads.getProjectThreadRecords(target, ["runs"]);
    const marker = markerId === null ? undefined : runs.find((run) => run.id === markerId);
    const terminalNoticeMarker = runs.find((run) => run.id === terminalNoticeMarkerId);
    const terminalRuns = runs
      .filter(
        (run) =>
          (marker === undefined || run.ordinal > marker.ordinal) &&
          terminalReason(run.status) !== undefined,
      )
      .toSorted((left, right) => left.ordinal - right.ordinal);
    if (terminalRuns.length === 0) return [];
    const { messages } = yield* threads.getProjectThreadRecords(target, ["messages"], {
      messageRunIds: terminalRuns.map((run) => run.id),
      messageIds: terminalRuns.map((run) => run.userMessageId),
    });
    const messagesById = new Map(messages.map((message) => [message.id, message]));
    return terminalRuns.map((run) => ({
      run,
      inputMessage: messagesById.get(run.userMessageId) ?? null,
      noticeAcknowledged:
        terminalNoticeMarker !== undefined && run.ordinal <= terminalNoticeMarker.ordinal,
    }));
  });

  /** Sends one agent's wakes to its coordinator chat, folding into a queued wake. */
  const deliver = Effect.fn("FirstmateReactor.deliver")(function* (
    target: ThreadId,
    projectId: ProjectId,
    wakes: ReadonlyArray<FirstmateWake>,
    parkedTaskIds: ReadonlySet<string>,
  ) {
    const pending = yield* pendingWake(projectId, target);
    const pendingWakes = pending?.wakes.filter((wake) => !parkedTaskIds.has(wake.taskId)) ?? [];
    if (
      pending !== undefined &&
      pendingWakes.length !== pending.wakes.length &&
      wakes.length === 0
    ) {
      const updateId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      if (pendingWakes.length === 0) {
        yield* threads.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`firstmate:wake-cancel-parked:${updateId}`),
          threadId: target,
          runId: pending.runId,
        });
        return;
      }
      yield* threads.dispatch({
        type: "queued-notification.revise",
        commandId: CommandId.make(`firstmate:wake-remove-parked:${updateId}`),
        threadId: target,
        runId: pending.runId,
        text: wakeDigest(pendingWakes),
        notification: wakeNotification(pendingWakes),
      });
    }
    // A restart or stop holds the coordinator's queue until someone resumes it,
    // and a wake folded into a held run never reaches the coordinator. Once no
    // turn is in flight, send the held digest again as a new wake and drop the
    // held one. While a turn runs, a new wake would queue behind it and be held
    // too, so the wake keeps folding into the held run until that turn ends.
    if (pending?.held === true && !pending.busy) {
      const wakeId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const merged = mergeWakes(pendingWakes, wakes);
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
      const wakeId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      if (pending !== undefined) {
        // At most one wake waits: fold this pass into the one already queued.
        const merged = mergeWakes(pendingWakes, wakes);
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
        const parkedTaskIds = new Set(
          tasks.filter((task) => task.status === "backlog").map((task) => String(task.id)),
        );
        const now = yield* Clock.currentTimeMillis;
        const previouslySeen = yield* Ref.get(seen);
        const activeKeys = new Set<string>();
        const wakesByAgent = new Map<string, FirstmateWake[]>();
        const acknowledgements: Effect.Effect<void, FirstmateError>[] = [];
        for (const task of tasks) {
          // Defensive even when listStored's default query excludes closed tasks.
          if (task.state === "done" || task.state === "dropped") continue;
          // Backlog is intentionally parked. It remains visible on the board
          // but must not wake the coordinator or trigger orphan recovery.
          if (task.status === "backlog") continue;
          if (!shells.has(task.agentId)) continue;
          const taskReasons: FirstmateWakeReason[] = [];
          const worker =
            task.workerThreadId === null
              ? null
              : yield* threads.getThreadShell(task.workerThreadId);
          let wakeRunId: OrchestrationV2Run["id"] | undefined;
          if (task.wakeAt !== null && Date.parse(task.wakeAt) <= now) {
            const key = `${task.id}:wake:${task.wakeAt}`;
            activeKeys.add(key);
            if (!previouslySeen.has(key)) taskReasons.push("wake-time");
          }
          if (worker !== null) {
            const terminalRuns =
              worker.activeRunId === null
                ? yield* terminalRunsAfter(
                    worker,
                    task.lastReportedRunId,
                    task.lastTerminalNoticeRunId,
                  )
                : [];
            const actionableCompletions = terminalRuns.flatMap(({ run, inputMessage }) =>
              run.status === "completed" &&
              run.startedAt !== null &&
              inputMessage !== null &&
              isCoordinatorInput(inputMessage)
                ? [run]
                : [],
            );
            const hasPendingBackground = backgroundWorkHoldsCompletion(
              worker.pendingBackgroundTasks ?? [],
            );
            if (!hasPendingBackground) {
              const completion = actionableCompletions.at(-1);
              if (completion !== undefined) {
                taskReasons.push("worker-completed");
                wakeRunId = completion.id;
              }
            }
            // A completion can stay held behind background work while a later
            // failure or monitor update wakes. Its separate durable watermark
            // acknowledges those notices without consuming the held completion.
            let terminalNoticeRunId: string | undefined;
            for (const { run, inputMessage, noticeAcknowledged } of terminalRuns) {
              const reason = terminalReason(run.status);
              if (
                run.startedAt === null ||
                noticeAcknowledged ||
                reason === undefined ||
                (reason === "worker-completed" && !isActionableMonitorNotice(inputMessage))
              )
                continue;
              if (!taskReasons.includes(reason)) taskReasons.push(reason);
              wakeRunId ??= run.id;
              terminalNoticeRunId = String(run.id);
            }
            if (terminalNoticeRunId !== undefined) {
              acknowledgements.push(firstmate.markTerminalNoticeRun(task.id, terminalNoticeRunId));
            }
            const heldCompletion = hasPendingBackground ? actionableCompletions[0] : undefined;
            const consumedRun = terminalRuns.findLast(
              ({ run }) => heldCompletion === undefined || run.ordinal < heldCompletion.ordinal,
            )?.run;
            if (consumedRun !== undefined) {
              acknowledgements.push(firstmate.markReportedRun(task.id, String(consumedRun.id)));
            }
            if (worker.status === "waiting" || worker.pendingRuntimeRequest !== null) {
              // A second request in the same run deserves a fresh notification.
              const key = `${task.id}:waiting:${task.workerThreadId}:${worker.pendingRuntimeRequest?.id ?? worker.latestRunId}`;
              activeKeys.add(key);
              if (!previouslySeen.has(key)) taskReasons.push("worker-waiting");
            }
          }
          // Pending subagents and monitors keep the worker alive after its root run ends.
          const hasRunningWorker =
            worker !== null &&
            (worker.activeRunId !== null ||
              backgroundWorkHoldsCompletion(worker.pendingBackgroundTasks ?? []) ||
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
            const runId = wakeRunId ?? worker?.latestRunId;
            wakes.push({
              taskId: String(task.id),
              title: task.title,
              reason: taskReasons[0]!,
              additionalReasons: taskReasons.slice(1),
              ...(runId == null ? {} : { runId: String(runId) }),
            });
            wakesByAgent.set(task.agentId, wakes);
          }
        }
        for (const { agentId, threadId, shell } of shells.values()) {
          yield* deliver(threadId, shell.projectId, wakesByAgent.get(agentId) ?? [], parkedTaskIds);
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

  const start = Effect.fn("FirstmateReactor.start")(function* () {
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
