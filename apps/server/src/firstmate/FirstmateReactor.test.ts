import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as FirstmateHome from "./FirstmateHome.ts";
import * as FirstmateReactor from "./FirstmateReactor.ts";
import * as FirstmateService from "./FirstmateService.ts";

const coordinatorId = ThreadId.make("coordinator");
const workerId = ThreadId.make("worker");
const projectId = ProjectId.make("project:firstmate-reactor");
const epoch = "1970-01-01T00:00:00.000Z";

const shell = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => {
  const instanceId = ProviderInstanceId.make("codex");
  return {
    id,
    projectId,
    title: String(id),
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: epoch as never,
    updatedAt: epoch as never,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
};

const sendFailure = new ThreadManagement.ThreadManagementThreadNotFoundError({
  projectId,
  threadId: coordinatorId,
});

/**
 * The real Firstmate store over in-memory SQLite, with thread shells and sends
 * scripted by the test. `failSends` makes the next sends fail while it is true.
 */
const makeHarness = Effect.fn("firstmateReactorTestHarness")(function* () {
  const workers = yield* Ref.make<ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>>(new Map());
  const sends = yield* Ref.make<ReadonlyArray<ThreadManagement.ThreadManagementSendInput>>([]);
  const failSends = yield* Ref.make(false);
  const layerThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) =>
      id === coordinatorId
        ? Effect.succeed(shell(id))
        : Ref.get(workers).pipe(Effect.map((map) => map.get(id) ?? null)),
    sendToThread: (input) =>
      Ref.get(failSends).pipe(
        Effect.flatMap((fail) =>
          fail
            ? Effect.fail(sendFailure)
            : Ref.update(sends, (values) => [...values, input]).pipe(
                Effect.andThen(Effect.succeed({} as ThreadManagement.ThreadManagementSendResult)),
              ),
        ),
      ),
  });
  const layerFirstmate = FirstmateService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FirstmateHome.FirstmateHome)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        layerThreads,
        NodeCrypto.layer,
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ),
    ),
  );
  const layer = FirstmateReactor.reactorLayer.pipe(
    Layer.provideMerge(layerFirstmate),
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        layerThreads,
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
      ),
    ),
  );
  const context = yield* Layer.build(layer);
  const service = yield* FirstmateService.FirstmateService.pipe(Effect.provide(context));
  const reactor = yield* FirstmateReactor.FirstmateReactor.pipe(Effect.provide(context));
  const setWorker = (value: OrchestrationV2ThreadShell) =>
    Ref.update(workers, (map) => new Map([...map, [value.id, value]]));
  return { service, reactor, sends, failSends, setWorker };
});

const createTask = (
  service: FirstmateService.FirstmateService["Service"],
  overrides: Partial<FirstmateService.FirstmateTaskCreateInput> = {},
) =>
  service
    .create({
      title: "Task one",
      intent: "Do the task.",
      definitionOfDone: "It is done.",
      ...overrides,
    })
    .pipe(Effect.map(({ task }) => task));

describe("FirstmateReactor", () => {
  it.effect("does nothing without a coordinator", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* createTask(harness.service);
        yield* TestClock.adjust("11 minutes");
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(0);
      }),
    ),
  );

  it.effect("queues one digest for a terminal worker run and does not repeat it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator({ threadId: coordinatorId });
        const task = yield* createTask(harness.service, {
          nextActor: "worker",
          workerThreadId: workerId,
        });
        yield* createTask(harness.service, { title: "Quiet task", nextActor: "user" });
        yield* harness.setWorker(
          shell(workerId, { status: "completed", latestRunId: RunId.make("run:done") }),
        );
        yield* harness.reactor.sweep();
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(1);
        expect(sends[0]).toMatchObject({
          mode: "queue",
          threadId: coordinatorId,
          createdBy: "agent",
          creationSource: "server",
          notification: {
            source: { kind: "monitor" },
            outcome: "completed",
            summary: "Firstmate: 1 update — Task one (worker finished)",
          },
        });
        expect(sends[0]!.text).toContain(`- ${task.id} Task one: worker-completed`);
        expect(sends[0]!.text).not.toContain("Quiet task");
        expect(sends[0]!.text).toContain("Reconcile with firstmate_task_list");

        // A new terminal run on the same worker wakes the coordinator again.
        yield* harness.setWorker(
          shell(workerId, { status: "failed", latestRunId: RunId.make("run:retry") }),
        );
        yield* harness.reactor.sweep();
        const after = yield* Ref.get(harness.sends);
        expect(after).toHaveLength(2);
        expect(after[1]!.text).toContain("Task one: worker-failed");
        expect(after[1]!.notification?.outcome).toBe("failed");
      }),
    ),
  );

  it.effect("keeps the wake for the next pass when the send fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator({ threadId: coordinatorId });
        yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
        yield* harness.setWorker(
          shell(workerId, { status: "completed", latestRunId: RunId.make("run:done") }),
        );
        yield* Ref.set(harness.failSends, true);
        const failure = yield* harness.reactor.sweep().pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "FirstmateError" });
        expect(yield* Ref.get(harness.sends)).toHaveLength(0);
        const [stored] = yield* harness.service.listStored();
        expect(stored!.lastReportedRunId).toBeNull();

        yield* Ref.set(harness.failSends, false);
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(1);
        expect(sends[0]!.text).toContain("worker-completed");
        const [acknowledged] = yield* harness.service.listStored();
        expect(acknowledged!.lastReportedRunId).toBe("run:done");
      }),
    ),
  );

  it.effect("wakes once for an orphan whose worker has stopped, until the task is updated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator({ threadId: coordinatorId });
        const task = yield* createTask(harness.service, {
          nextActor: "worker",
          workerThreadId: workerId,
        });
        // The worker is attached but idle: no running or starting run.
        yield* harness.setWorker(shell(workerId, { status: "idle" }));

        yield* TestClock.adjust("9 minutes");
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(0);

        yield* TestClock.adjust("2 minutes");
        yield* harness.reactor.sweep();
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(1);
        expect(sends[0]!.text).toContain(`- ${task.id} Task one: orphan`);

        // An update clears the orphan marker; ten quiet minutes later it wakes again.
        yield* harness.service.update({ taskId: task.id, summary: "Nudged the worker." });
        yield* TestClock.adjust("11 minutes");
        yield* harness.reactor.sweep();
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(2);
      }),
    ),
  );

  it.effect("does not treat a task with a running worker as an orphan", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator({ threadId: coordinatorId });
        yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
        yield* harness.setWorker(
          shell(workerId, { status: "running", activeRunId: RunId.make("run:live") }),
        );
        yield* TestClock.adjust("11 minutes");
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(0);
      }),
    ),
  );

  it.effect("sends one digest line per task when several reasons fire in one pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator({ threadId: coordinatorId });
        yield* createTask(harness.service, {
          nextActor: "worker",
          workerThreadId: workerId,
          wakeAt: "1970-01-01T00:01:00.000Z",
        });
        yield* createTask(harness.service, { title: "Second", wakeAt: epoch });
        yield* harness.setWorker(
          shell(workerId, { status: "completed", latestRunId: RunId.make("run:done") }),
        );
        yield* TestClock.adjust("2 minutes");
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(1);
        const lines = sends[0]!.text.split("\n").filter((line) => line.startsWith("- "));
        expect(lines).toHaveLength(2);
        expect(lines.find((line) => line.includes("Task one"))).toContain(
          "wake-time, worker-completed",
        );
      }),
    ),
  );
});

describe("wakeNotification", () => {
  const wake = (
    title: string,
    reason: FirstmateReactor.FirstmateWakeReason,
    additionalReasons: ReadonlyArray<FirstmateReactor.FirstmateWakeReason> = [],
  ): FirstmateReactor.FirstmateWake => ({
    taskId: `task:${title}`,
    title,
    reason,
    additionalReasons,
  });

  it("names tasks by title, picks the outcome, and folds long lists", () => {
    const notification = FirstmateReactor.wakeNotification([
      wake("Office dashboards", "worker-completed"),
      wake("PDF review", "worker-completed", ["worker-waiting"]),
      wake("Archived products", "orphan"),
      wake("Review bot", "wake-time"),
    ]);
    expect(notification.outcome).toBe("updated");
    expect(notification.summary).toBe(
      "Firstmate: 4 updates — Office dashboards (worker finished), PDF review (worker finished), Archived products (no worker running), and 1 more",
    );
    expect(notification.summary).not.toContain("task:");
    expect(notification.detail).toContain("Firstmate wake-up:");
  });

  it("reports a failure over any other outcome and shortens long titles", () => {
    const notification = FirstmateReactor.wakeNotification([
      wake("A very long task title that goes on well past the limit", "worker-waiting"),
      wake("Broken", "worker-failed"),
    ]);
    expect(notification.outcome).toBe("failed");
    expect(notification.summary).toContain("A very long task title that goes on wel…");
  });
});
