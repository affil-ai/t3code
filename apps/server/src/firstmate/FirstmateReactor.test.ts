import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Notification,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  FIRSTMATE_AGENT_ID,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
} from "../orchestration-v2/ProjectionStore.ts";
import { pullRequestWatchMessage } from "../orchestration-v2/pullRequestWatch.ts";
import type { PullRequestWatchChange } from "../orchestration-v2/pullRequestWatch.ts";
import * as FirstmateHome from "./FirstmateHome.ts";
import * as FirstmateReactor from "./FirstmateReactor.ts";
import * as FirstmateService from "./FirstmateService.ts";

const FM = FIRSTMATE_AGENT_ID;

const coordinatorId = ThreadId.make("coordinator");
const workerId = ThreadId.make("worker");
const otherCoordinatorId = ThreadId.make("coordinator-growth");
const otherWorkerId = ThreadId.make("worker-growth");
const projectId = ProjectId.make("project:firstmate-reactor");
const epoch = "1970-01-01T00:00:00.000Z";
let shellAuthoredMessageSequence = 0;
const decodePendingBackgroundTask = Schema.decodeUnknownEffect(
  OrchestrationV2PendingBackgroundTask,
);

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
    latestUserAuthoredMessageAt: DateTime.makeUnsafe(shellAuthoredMessageSequence++),
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
  type WorkerInput = {
    readonly runId: string;
    readonly messageId: string;
    readonly status: OrchestrationV2ThreadShell["status"];
    readonly started?: boolean;
    readonly createdBy: "user" | "agent";
    readonly creationSource: "web" | "mcp" | "server";
    readonly notification?: OrchestrationV2Notification;
  };
  const workerInputs = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<WorkerInput>>>(new Map());
  type RecordRead = {
    readonly input: { readonly projectId: ProjectId; readonly threadId: ThreadId };
    readonly fields: ReadonlyArray<ProjectionRecordField>;
    readonly filter: ProjectionRecordFilter | undefined;
  };
  const recordReads = yield* Ref.make<ReadonlyArray<RecordRead>>([]);
  // A wake still waiting in the coordinator's queue, as the projection would show it.
  const queued = yield* Ref.make<{
    readonly runId: string;
    readonly text: string;
    readonly held?: boolean;
  } | null>(null);
  // Status of the coordinator's in-flight turn, if any, beside the queued wake.
  const activeStatus = yield* Ref.make<string | null>(null);
  const revisions = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const layerThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getProjectThreadRecords: (input, fields, filter) =>
      Ref.update(recordReads, (reads) => [...reads, { input, fields, filter }]).pipe(
        Effect.andThen(Ref.get(workerInputs)),
        Effect.flatMap((inputs) => {
          const workerInput = inputs.get(String(input.threadId));
          const requestedFields = fields as ReadonlyArray<string>;
          if (workerInput !== undefined) {
            return Effect.succeed({
              ...(requestedFields.includes("runs")
                ? {
                    runs: workerInput
                      .map(({ runId, messageId, status, started }, index) => ({
                        id: RunId.make(runId),
                        ordinal: index + 1,
                        status,
                        startedAt:
                          (started ?? (status !== "cancelled" && status !== "rolled_back"))
                            ? (epoch as never)
                            : null,
                        userMessageId: MessageId.make(messageId),
                      }))
                      .filter(
                        (run) => filter?.runIds === undefined || filter.runIds.includes(run.id),
                      ),
                  }
                : {}),
              ...(requestedFields.includes("messages")
                ? {
                    messages: workerInput
                      .map(({ messageId, createdBy, creationSource, runId, notification }) => ({
                        id: MessageId.make(messageId),
                        runId: RunId.make(runId),
                        createdBy,
                        creationSource,
                        ...(notification === undefined ? {} : { notification }),
                      }))
                      .filter(
                        (message) =>
                          (filter?.messageIds === undefined ||
                            filter.messageIds.includes(message.id)) &&
                          (filter?.messageRunIds === undefined ||
                            filter.messageRunIds.includes(message.runId)),
                      ),
                  }
                : {}),
            } as never);
          }
          return Effect.all([Ref.get(queued), Ref.get(activeStatus)]).pipe(
            Effect.map(([wake, active]) => {
              const messageId = MessageId.make("firstmate:wake-message:queued");
              return {
                runs: [
                  ...(active === null
                    ? []
                    : [{ id: RunId.make("run:active"), status: active, userMessageId: "user" }]),
                  ...(wake === null
                    ? []
                    : [
                        {
                          id: RunId.make(wake.runId),
                          status: "queued",
                          userMessageId: messageId,
                          ...(wake.held === true ? { queueHeld: true } : {}),
                        },
                      ]),
                ],
                messages: wake === null ? [] : [{ id: messageId, text: wake.text }],
              } as never;
            }),
          );
        }),
      ),
    dispatch: (command) =>
      Ref.update(revisions, (values) => [...values, command]).pipe(
        Effect.as({ sequence: 1, storedEvents: [] } as never),
      ),
    getThreadShell: (id) =>
      id === coordinatorId || id === otherCoordinatorId
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
  const sqlite = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
  const layerFirstmate = FirstmateService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FirstmateHome.FirstmateHome)({
          migrateLegacyHome: () => Effect.succeed(null),
          migrateAgentsFolder: () => Effect.succeed([]),
          artifactsRoot: "/agents/artifacts",
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        layerThreads,
        NodeCrypto.layer,
        Layer.succeedContext(sqlite),
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
  // Rebuild only the reactor: its Ref state is fresh, but SQLite and thread records survive.
  const rebuildReactor = () =>
    Effect.gen(function* () {
      const rebuilt = yield* Layer.build(
        FirstmateReactor.reactorLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(FirstmateService.FirstmateService, service),
              NodeCrypto.layer,
              layerThreads,
              Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
            ),
          ),
        ),
      );
      return yield* FirstmateReactor.FirstmateReactor.pipe(Effect.provide(rebuilt));
    });
  const setWorkerInput = (workerThreadId: ThreadId, input: WorkerInput) =>
    Ref.update(workerInputs, (values) => {
      const previous = values.get(String(workerThreadId)) ?? [];
      return new Map([
        ...values,
        [
          String(workerThreadId),
          previous.some(({ runId }) => runId === input.runId)
            ? previous.map((entry) => (entry.runId === input.runId ? input : entry))
            : [...previous, input],
        ],
      ]);
    });
  const setWorker = (value: OrchestrationV2ThreadShell) =>
    Effect.all([
      Ref.update(workers, (map) => new Map([...map, [value.id, value]])),
      ...(value.latestRunId === null
        ? []
        : [
            Ref.get(workerInputs).pipe(
              Effect.flatMap((inputs) =>
                setWorkerInput(value.id, {
                  runId: String(value.latestRunId),
                  messageId: `message:${value.latestRunId}`,
                  createdBy: "user",
                  creationSource: "web",
                  ...inputs.get(String(value.id))?.find(({ runId }) => runId === value.latestRunId),
                  status: value.status,
                  ...(value.latestRunStartedAt === undefined
                    ? {}
                    : { started: value.latestRunStartedAt !== null }),
                }),
              ),
            ),
          ]),
    ]).pipe(Effect.asVoid);
  /** An agent row without starting a chat: the test sets its coordinator itself. */
  const createAgent = (name: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const id = `agent:${name.toLowerCase()}`;
      yield* sql`
        INSERT INTO firstmate_agent(agent_id, slug, name, icon, color, role, created_at)
        VALUES (${id}, ${name.toLowerCase()}, ${name}, 'bot', 'sky', 'Role.', ${epoch})
      `;
      const agent = (yield* service.listAgents()).find((candidate) => candidate.id === id)!;
      return { agent };
    }).pipe(Effect.provide(sqlite));
  return {
    service,
    reactor,
    rebuildReactor,
    sends,
    failSends,
    setWorker,
    setWorkerInput,
    recordReads,
    queued,
    activeStatus,
    revisions,
    createAgent,
  };
});

const createTask = (
  service: FirstmateService.FirstmateService["Service"],
  overrides: Partial<FirstmateService.FirstmateTaskCreateInput> = {},
) =>
  service
    .create(FM, {
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
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
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
          mode: "auto",
          threadId: coordinatorId,
          createdBy: "agent",
          creationSource: "server",
          notification: {
            source: { kind: "monitor" },
            outcome: "completed",
            summary: "Tasks: 1 update — Task one (worker finished)",
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

  it.effect("does not read worker runs again when the latest run is already reported", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
        yield* harness.setWorker(
          shell(workerId, { status: "completed", latestRunId: RunId.make("run:done") }),
        );
        yield* harness.reactor.sweep();
        const [reported] = yield* harness.service.listStored();
        expect(reported!.lastReportedRunId).toBe("run:done");

        yield* Ref.set(harness.recordReads, []);
        yield* harness.reactor.sweep();
        const workerReads = (yield* Ref.get(harness.recordReads)).filter(
          ({ input }) => input.threadId === workerId,
        );
        expect(workerReads).toHaveLength(0);
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);
      }),
    ),
  );

  it.effect("suppresses a terminal wake while the worker has an active run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
        for (const status of [
          "completed",
          "failed",
          "interrupted",
          "cancelled",
          "rolled_back",
        ] as const) {
          yield* harness.setWorker(
            shell(workerId, {
              status,
              latestRunId: RunId.make(`run:${status}`),
              latestRunStartedAt: DateTime.makeUnsafe(0),
              activeRunId: RunId.make("run:active"),
            }),
          );
          yield* harness.reactor.sweep();
          expect(yield* Ref.get(harness.sends)).toHaveLength(0);
        }
        const [stored] = yield* harness.service.listStored();
        expect(stored!.lastReportedRunId).toBeNull();
      }),
    ),
  );

  it.effect("consumes terminal runs that never started without waking", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
        for (const status of [
          "completed",
          "failed",
          "interrupted",
          "cancelled",
          "rolled_back",
        ] as const) {
          yield* harness.setWorker(
            shell(workerId, {
              status,
              latestRunId: RunId.make(`run:${status}`),
              latestRunStartedAt: null,
            }),
          );
          yield* harness.reactor.sweep();
          expect(yield* Ref.get(harness.sends)).toHaveLength(0);
          const [stored] = yield* harness.service.listStored();
          expect(stored!.lastReportedRunId).toBe(`run:${status}`);
        }
      }),
    ),
  );

  it.effect.each(["subagent", "monitor", "background_task", "future_kind"])(
    "defers completion while %s work remains",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
          yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
          const authoredAt = "1970-01-01T00:00:01.000Z" as never;
          yield* harness.setWorker(
            shell(workerId, {
              status: "completed",
              latestRunId: RunId.make("run:done"),
              latestUserAuthoredMessageAt: authoredAt,
              pendingBackgroundTasks: [
                yield* decodePendingBackgroundTask({
                  kind,
                  taskId: "pending:one",
                }),
              ],
            }),
          );
          yield* harness.reactor.sweep();
          expect(yield* Ref.get(harness.sends)).toHaveLength(0);

          yield* harness.setWorker(
            shell(workerId, {
              status: "completed",
              latestRunId: RunId.make("run:done"),
              latestUserAuthoredMessageAt: authoredAt,
              pendingBackgroundTasks: [],
            }),
          );
          yield* harness.reactor.sweep();
          expect(yield* Ref.get(harness.sends)).toHaveLength(1);
        }),
      ),
  );

  it.effect("does not hold completion for a long-lived background command", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
        yield* harness.setWorker(
          shell(workerId, {
            status: "completed",
            latestRunId: RunId.make("run:done"),
            pendingBackgroundTasks: [{ kind: "command", taskId: "dev-server" }],
          }),
        );
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);
        const rebuilt = yield* harness.rebuildReactor();
        yield* rebuilt.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);
      }),
    ),
  );

  it.effect.each(["routine checks", "new review comment", "new conflict", "failed check"])(
    "PR-watch completion contract: %s",
    (change) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
          yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
          const changes: ReadonlyArray<PullRequestWatchChange> =
            change === "routine checks"
              ? [{ kind: "checks-passed", count: 2, required: true }]
              : change === "new conflict"
                ? [{ kind: "conflicting" }]
                : change === "failed check"
                  ? [
                      {
                        kind: "checks-failed",
                        failed: [{ name: "test", status: "failure", description: null, url: null }],
                      },
                    ]
                  : [
                      {
                        kind: "remarks",
                        remarks: [
                          {
                            id: "review:one",
                            kind: "review-comment",
                            author: { login: "reviewer", name: null, avatarUrl: null },
                            body: "Please add a regression test.",
                            createdAt: epoch,
                            url: null,
                            path: "src/index.ts",
                            reviewState: null,
                          },
                        ],
                      },
                    ];
          // Use the production producer, including its structured notification.
          const message = pullRequestWatchMessage({
            number: 12,
            url: "https://github.com/example/repo/pull/12",
            baseBranch: "main",
            headSha: "aaaaaaaaaa",
            report: {
              changes,
              exhausted: false,
              next: {
                startedAt: epoch,
                headSha: "aaaaaaaaaa",
                failedChecks: [],
                passed: false,
                passedChecks: [],
                remarksThrough: epoch,
                remarkIds: [],
                conflicting: false,
                wakes: 0,
              },
            },
          });
          yield* harness.setWorker(
            shell(workerId, {
              status: "completed",
              latestRunId: RunId.make("run:pr-watch"),
              pendingBackgroundTasks: [{ kind: "monitor", taskId: "pull-request-watch:12" }],
            }),
          );
          yield* harness.setWorkerInput(workerId, {
            runId: "run:pr-watch",
            messageId: "message:pr-watch:one",
            status: "completed",
            createdBy: "agent",
            creationSource: "server",
            notification: message.notification,
          });
          yield* harness.reactor.sweep();
          const rebuilt = yield* harness.rebuildReactor();
          yield* rebuilt.sweep();
          const sends = yield* Ref.get(harness.sends);
          expect(sends).toHaveLength(change === "routine checks" ? 0 : 1);
          if (change !== "routine checks") expect(sends[0]!.text).toContain("worker-completed");
        }),
      ),
  );

  it.effect("keeps a delegated child result quiet while the parent is waiting_for_children", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
        yield* harness.setWorker(
          shell(workerId, {
            status: "completed",
            latestRunId: RunId.make("run:child-result"),
            pendingBackgroundTasks: [
              {
                kind: "subagent",
                taskId: "delegated:parent",
                childThreadId: ThreadId.make("parent-waiting-for-children"),
              },
            ],
          }),
        );
        yield* harness.setWorkerInput(workerId, {
          runId: "run:child-result",
          messageId: "message:delegated-result",
          status: "completed",
          createdBy: "agent",
          creationSource: "server",
          notification: {
            source: { kind: "delegated_task", taskIds: [] },
            outcome: "completed",
            summary: "Child result available; parent is waiting_for_children.",
          },
        });
        yield* TestClock.adjust("11 minutes");
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(0);
      }),
    ),
  );

  it.effect("ignores server notices, but wakes for an MCP-briefed worker completion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
        const authoredAt = "1970-01-01T00:00:02.000Z" as never;
        yield* harness.setWorker(
          shell(workerId, {
            status: "completed",
            latestRunId: RunId.make("run:done"),
            latestUserAuthoredMessageAt: authoredAt,
          }),
        );
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);

        // PR-watch or delegated-completion notices are server-created messages.
        yield* harness.setWorker(
          shell(workerId, {
            status: "completed",
            latestRunId: RunId.make("run:notice"),
            latestUserAuthoredMessageAt: authoredAt,
          }),
        );
        yield* harness.setWorkerInput(workerId, {
          runId: "run:notice",
          messageId: "message:notice",
          status: "completed",
          createdBy: "agent",
          creationSource: "server",
        });
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);

        yield* harness.setWorker(
          shell(workerId, {
            status: "completed",
            latestRunId: RunId.make("run:authored"),
            latestUserAuthoredMessageAt: "1970-01-01T00:00:03.000Z" as never,
          }),
        );
        yield* harness.setWorkerInput(workerId, {
          runId: "run:authored",
          messageId: "message:authored",
          status: "completed",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(2);
      }),
    ),
  );

  it.effect("reports an actionable completion hidden behind a newer server notice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        const task = yield* createTask(harness.service, {
          nextActor: "worker",
          workerThreadId: workerId,
        });
        yield* harness.setWorker(
          shell(workerId, {
            status: "completed",
            latestRunId: RunId.make("run:mcp"),
          }),
        );
        yield* harness.setWorkerInput(workerId, {
          runId: "run:mcp",
          messageId: "message:mcp",
          status: "completed",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* harness.setWorker(
          shell(workerId, {
            status: "completed",
            latestRunId: RunId.make("run:notice"),
          }),
        );
        yield* harness.setWorkerInput(workerId, {
          runId: "run:notice",
          messageId: "message:notice",
          status: "completed",
          createdBy: "agent",
          creationSource: "server",
        });

        yield* harness.reactor.sweep();
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(1);
        expect(sends[0]!.text).toContain(`- ${task.id} Task one: worker-completed`);
        const messageRead = (yield* Ref.get(harness.recordReads)).find(
          ({ input, fields }) =>
            input.threadId === workerId && fields.length === 1 && fields[0] === "messages",
        );
        expect(messageRead?.filter?.messageRunIds?.map(String)).toEqual(["run:mcp", "run:notice"]);
        expect(messageRead?.filter?.messageIds?.map(String)).toEqual([
          "message:mcp",
          "message:notice",
        ]);
        const [stored] = yield* harness.service.listStored();
        expect(stored!.lastReportedRunId).toBe("run:notice");
      }),
    ),
  );

  it.effect("reports a failure hidden behind a newer server notice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        const task = yield* createTask(harness.service, {
          nextActor: "worker",
          workerThreadId: workerId,
        });
        yield* harness.setWorker(
          shell(workerId, {
            status: "failed",
            latestRunId: RunId.make("run:failed"),
          }),
        );
        yield* harness.setWorker(
          shell(workerId, {
            status: "completed",
            latestRunId: RunId.make("run:notice"),
          }),
        );
        yield* harness.setWorkerInput(workerId, {
          runId: "run:notice",
          messageId: "message:notice",
          status: "completed",
          createdBy: "agent",
          creationSource: "server",
        });

        yield* harness.reactor.sweep();
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(1);
        expect(sends[0]!.text).toContain(`- ${task.id} Task one: worker-failed`);
        const [stored] = yield* harness.service.listStored();
        expect(stored!.lastReportedRunId).toBe("run:notice");
      }),
    ),
  );

  it.effect("holds a completion marker for background work without repeating later failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        const task = yield* createTask(harness.service, {
          nextActor: "worker",
          workerThreadId: workerId,
        });
        // A notice before the completion can be consumed, but later runs cannot.
        yield* harness.setWorkerInput(workerId, {
          runId: "run:before",
          messageId: "message:before",
          status: "completed",
          createdBy: "agent",
          creationSource: "server",
        });
        yield* harness.setWorkerInput(workerId, {
          runId: "run:mcp",
          messageId: "message:mcp",
          status: "completed",
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* harness.setWorkerInput(workerId, {
          runId: "run:failed",
          messageId: "message:failed",
          status: "failed",
          createdBy: "agent",
          creationSource: "server",
        });
        const notice = shell(workerId, {
          status: "completed",
          latestRunId: RunId.make("run:notice"),
          pendingBackgroundTasks: [{ kind: "subagent", taskId: "subagent:one" }],
        });
        yield* harness.setWorker(notice);
        yield* harness.setWorkerInput(workerId, {
          runId: "run:notice",
          messageId: "message:notice",
          status: "completed",
          createdBy: "agent",
          creationSource: "server",
        });
        yield* harness.reactor.sweep();
        yield* harness.reactor.sweep();
        const firstSends = yield* Ref.get(harness.sends);
        expect(firstSends).toHaveLength(1);
        expect(firstSends[0]!.text).toContain("worker-failed");
        expect(firstSends[0]!.text).not.toContain("worker-completed");
        const [held] = yield* harness.service.listStored();
        expect(held!.lastReportedRunId).toBe("run:before");
        expect(held!.lastTerminalNoticeRunId).toBe("run:failed");

        // A restart loses in-memory dedupe, but not the terminal-notice acknowledgement.
        const rebuilt = yield* harness.rebuildReactor();
        yield* rebuilt.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);

        // A running delivery between sweeps must not forget the failure dedupe.
        yield* harness.setWorker({ ...notice, activeRunId: RunId.make("run:active") });
        yield* rebuilt.sweep();
        yield* harness.setWorker(notice);
        yield* rebuilt.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);

        yield* harness.setWorker({ ...notice, pendingBackgroundTasks: [] });
        yield* rebuilt.sweep();
        yield* rebuilt.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(2);
        expect(sends[1]!.text).toContain(`- ${task.id} Task one: worker-completed`);
        expect(sends[1]!.text).not.toContain("worker-failed");
        const [consumed] = yield* harness.service.listStored();
        expect(consumed!.lastReportedRunId).toBe("run:notice");
        const messageReads = (yield* Ref.get(harness.recordReads)).filter(
          ({ input, fields }) => input.threadId === workerId && fields.includes("messages"),
        );
        expect(messageReads[1]!.filter?.messageRunIds?.map(String)).toEqual([
          "run:mcp",
          "run:failed",
          "run:notice",
        ]);
      }),
    ),
  );

  it.effect("keeps the wake for the next pass when the send fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
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

  it.effect("does not acknowledge a terminal notice when its send fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
        yield* harness.setWorker(
          shell(workerId, {
            status: "failed",
            latestRunId: RunId.make("run:failed"),
            pendingBackgroundTasks: [{ kind: "subagent", taskId: "pending:one" }],
          }),
        );
        yield* Ref.set(harness.failSends, true);
        yield* harness.reactor.sweep().pipe(Effect.flip);
        const [unreported] = yield* harness.service.listStored();
        expect(unreported!.lastTerminalNoticeRunId).toBeNull();
        expect(unreported!.lastReportedRunId).toBeNull();

        yield* Ref.set(harness.failSends, false);
        const rebuilt = yield* harness.rebuildReactor();
        yield* rebuilt.sweep();
        const [reported] = yield* harness.service.listStored();
        expect(reported!.lastTerminalNoticeRunId).toBe("run:failed");
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);
        expect((yield* Ref.get(harness.sends))[0]!.text).toContain("worker-failed");
      }),
    ),
  );

  it.effect("wakes once for an orphan whose worker has stopped, until the task is updated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
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
        yield* harness.service.update(FM, { taskId: task.id, summary: "Nudged the worker." });
        yield* TestClock.adjust("11 minutes");
        yield* harness.reactor.sweep();
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(2);
      }),
    ),
  );

  it.effect("still wakes for a waiting worker or a pending runtime request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
        yield* harness.setWorker(
          shell(workerId, {
            status: "waiting",
            latestRunId: RunId.make("run:waiting"),
            activeRunId: RunId.make("run:waiting"),
          }),
        );
        yield* harness.reactor.sweep();
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(1);
        expect(sends[0]!.text).toContain("worker-waiting");

        yield* harness.setWorker(
          shell(workerId, {
            status: "running",
            latestRunId: RunId.make("run:waiting"),
            activeRunId: RunId.make("run:waiting"),
            pendingRuntimeRequest: {
              id: "request:one" as never,
              kind: "user_input",
              createdAt: epoch as never,
            },
          }),
        );
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(2);
      }),
    ),
  );

  it.effect("does not wake parked tasks, and resumes orphan detection after promotion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        const task = yield* createTask(harness.service, { status: "backlog", wakeAt: epoch });
        yield* TestClock.adjust("11 minutes");
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(0);
        yield* harness.service.update(FM, {
          taskId: task.id,
          status: "planning",
          summary: "Start planning",
        });
        yield* TestClock.adjust("11 minutes");
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);
      }),
    ),
  );

  it.effect("wakes for a monitoring task's scheduled check, unlike a parked task", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        const task = yield* createTask(harness.service, { status: "monitoring", wakeAt: epoch });
        yield* harness.reactor.sweep();
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(1);
        expect(sends[0]!.text).toContain(task.id);
      }),
    ),
  );

  it.effect("rejects parking an active worker and removes a parked task's held wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        const task = yield* createTask(harness.service, {
          nextActor: "worker",
          workerThreadId: workerId,
        });
        yield* harness.setWorker(
          shell(workerId, {
            status: "running",
            activeRunId: RunId.make("run:live"),
          }),
        );
        expect(
          yield* harness.service
            .update(FM, {
              taskId: task.id,
              status: "backlog",
              summary: "Park it",
            })
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "FirstmateError" });
        yield* harness.setWorker(shell(workerId));
        yield* harness.service.update(FM, {
          taskId: task.id,
          status: "backlog",
          summary: "Park idle work",
        });
        yield* Ref.set(harness.queued, {
          runId: "run:queued",
          held: true,
          text: `Wake-up from your task board:\n- ${task.id} Task one: orphan\n`,
        });
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(0);
        expect(yield* Ref.get(harness.revisions)).toMatchObject([
          { type: "queued-run.cancel", runId: "run:queued" },
        ]);
      }),
    ),
  );

  it.effect("does not treat a task with a running worker as an orphan", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
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

  it.effect.each(["subagent", "monitor"] as const)(
    "does not orphan a completed root run with pending %s work",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
          yield* createTask(harness.service, { nextActor: "worker", workerThreadId: workerId });
          yield* harness.setWorker(
            shell(workerId, {
              status: "completed",
              latestRunId: RunId.make("run:done"),
              pendingBackgroundTasks: [{ kind, taskId: "pending:one" }],
            }),
          );
          yield* TestClock.adjust("11 minutes");
          yield* harness.reactor.sweep();
          expect(yield* Ref.get(harness.sends)).toHaveLength(0);
          const [stored] = yield* harness.service.listStored();
          expect(stored!.orphanNotifiedAt).toBeNull();
        }),
      ),
  );

  it.effect("sends one digest line per task when several reasons fire in one pass", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
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

describe("FirstmateReactor pending wakes", () => {
  it.effect("folds a new wake into the queued one instead of queueing a second", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        const first = yield* createTask(harness.service, {
          title: "Dashboards",
          nextActor: "worker",
          workerThreadId: workerId,
        });
        yield* harness.setWorker(
          shell(workerId, { status: "completed", latestRunId: RunId.make("run:1") }),
        );
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(1);
        // That wake is still queued behind the user's turn when the next one comes.
        yield* Ref.set(harness.queued, { runId: "run:wake-queued", text: sends[0]!.text });
        const secondWorker = ThreadId.make("worker-two");
        const second = yield* createTask(harness.service, {
          title: "PDF review",
          nextActor: "worker",
          workerThreadId: secondWorker,
        });
        yield* harness.setWorker(
          shell(secondWorker, { status: "failed", latestRunId: RunId.make("run:2") }),
        );
        yield* harness.setWorker(
          shell(workerId, { status: "completed", latestRunId: RunId.make("run:3") }),
        );
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);
        const revisions = yield* Ref.get(harness.revisions);
        expect(revisions).toHaveLength(1);
        const revise = revisions[0]!;
        expect(revise).toMatchObject({
          type: "queued-notification.revise",
          runId: "run:wake-queued",
        });
        if (revise.type !== "queued-notification.revise") throw new Error("unexpected command");
        // One line per task; the first task's two runs combine into one line.
        expect(revise.text).toContain(`- ${first.id} Dashboards: worker-completed\n`);
        expect(revise.text).toContain(`- ${second.id} PDF review: worker-failed`);
        expect(revise.text.match(/Dashboards/g)).toHaveLength(1);
        expect(revise.notification.outcome).toBe("failed");
        expect(revise.notification.summary).toBe(
          "Tasks: 2 updates — Dashboards (worker finished), PDF review (worker failed)",
        );
      }),
    ),
  );

  it.effect("sends a held wake again once the coordinator is idle, and drops the held one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        const task = yield* createTask(harness.service, {
          title: "Dashboards",
          nextActor: "worker",
          workerThreadId: workerId,
        });
        yield* harness.setWorker(
          shell(workerId, { status: "completed", latestRunId: RunId.make("run:1") }),
        );
        yield* harness.reactor.sweep();
        const [first] = yield* Ref.get(harness.sends);
        // A server restart held the coordinator's queue with that wake in it.
        yield* Ref.set(harness.queued, {
          runId: "run:wake-held",
          text: first!.text,
          held: true,
        });

        // No new task wakes, but the held one is still delivered.
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(2);
        expect(sends[1]).toMatchObject({ mode: "auto", threadId: coordinatorId });
        expect(sends[1]!.text).toContain(`- ${task.id} Dashboards: worker-completed`);
        expect(sends[1]!.messageId).not.toBe(first!.messageId);
        expect(yield* Ref.get(harness.revisions)).toEqual([
          expect.objectContaining({ type: "queued-run.cancel", runId: "run:wake-held" }),
        ]);
      }),
    ),
  );

  it.effect("folds into a held wake while the coordinator's turn runs, then sends it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        yield* createTask(harness.service, {
          title: "Dashboards",
          nextActor: "worker",
          workerThreadId: workerId,
        });
        yield* harness.setWorker(
          shell(workerId, { status: "completed", latestRunId: RunId.make("run:1") }),
        );
        yield* harness.reactor.sweep();
        const [first] = yield* Ref.get(harness.sends);
        yield* Ref.set(harness.queued, {
          runId: "run:wake-held",
          text: first!.text,
          held: true,
        });
        // The user is talking to the coordinator: a new wake would queue behind
        // that turn and be held too, so it folds into the held wake for now.
        yield* Ref.set(harness.activeStatus, "running");
        yield* harness.setWorker(
          shell(workerId, { status: "completed", latestRunId: RunId.make("run:2") }),
        );
        yield* harness.reactor.sweep();
        expect(yield* Ref.get(harness.sends)).toHaveLength(1);
        const [revise] = yield* Ref.get(harness.revisions);
        expect(revise).toMatchObject({
          type: "queued-notification.revise",
          runId: "run:wake-held",
        });

        // The user's turn ends; the next pass delivers the held wake.
        yield* Ref.set(harness.activeStatus, null);
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends).toHaveLength(2);
        expect(sends[1]!.text).toContain("Dashboards: worker-completed");
        expect((yield* Ref.get(harness.revisions)).at(-1)).toMatchObject({
          type: "queued-run.cancel",
          runId: "run:wake-held",
        });
      }),
    ),
  );
});

describe("parseWakeDigest", () => {
  it("reads back what wakeDigest wrote", () => {
    const wakes: ReadonlyArray<FirstmateReactor.FirstmateWake> = [
      {
        taskId: "firstmate-task:a",
        title: "Ship: the thing",
        reason: "worker-failed",
        additionalReasons: ["orphan"],
      },
      { taskId: "firstmate-task:b", title: "Other", reason: "wake-time", additionalReasons: [] },
    ];
    expect(FirstmateReactor.parseWakeDigest(FirstmateReactor.wakeDigest(wakes))).toEqual(wakes);
  });

  it("merges reasons per task, keeping first positions", () => {
    const merged = FirstmateReactor.mergeWakes(
      [{ taskId: "a", title: "A", reason: "worker-completed", additionalReasons: [] }],
      [
        { taskId: "b", title: "B", reason: "orphan" },
        {
          taskId: "a",
          title: "A",
          reason: "worker-failed",
          additionalReasons: ["worker-completed"],
        },
      ],
    );
    expect(merged).toEqual([
      { taskId: "a", title: "A", reason: "worker-completed", additionalReasons: ["worker-failed"] },
      { taskId: "b", title: "B", reason: "orphan" },
    ]);
  });
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
      "Tasks: 4 updates — Office dashboards (worker finished), PDF review (worker finished), Archived products (no worker running), and 1 more",
    );
    expect(notification.summary).not.toContain("task:");
    expect(notification.detail).toContain("Wake-up from your task board:");
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

describe("FirstmateReactor agents", () => {
  it.effect("wakes each agent's own chat with only its tasks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.service.setCoordinator(FM, { threadId: coordinatorId });
        const { agent } = yield* harness.createAgent("Growth");
        yield* harness.service.setCoordinator(agent.id, { threadId: otherCoordinatorId });
        const mine = yield* createTask(harness.service, {
          title: "Firstmate task",
          nextActor: "worker",
          workerThreadId: workerId,
        });
        const theirs = yield* harness.service.create(agent.id, {
          title: "Growth task",
          intent: "Grow.",
          definitionOfDone: "Grown.",
          nextActor: "worker",
          workerThreadId: otherWorkerId,
        });
        yield* harness.setWorker(
          shell(workerId, { status: "completed", latestRunId: RunId.make("run:a") }),
        );
        yield* harness.setWorker(
          shell(otherWorkerId, { status: "failed", latestRunId: RunId.make("run:b") }),
        );
        yield* harness.reactor.sweep();
        const sends = yield* Ref.get(harness.sends);
        expect(sends.map((send) => send.threadId).sort()).toEqual(
          [coordinatorId, otherCoordinatorId].sort(),
        );
        const toFirstmate = sends.find((send) => send.threadId === coordinatorId)!;
        const toGrowth = sends.find((send) => send.threadId === otherCoordinatorId)!;
        expect(toFirstmate.text).toContain(`- ${mine.id} Firstmate task`);
        expect(toFirstmate.text).not.toContain("Growth task");
        expect(toGrowth.text).toContain(`- ${theirs.task.id} Growth task`);
        expect(toGrowth.text).not.toContain("Firstmate task");
        expect(toGrowth.notification?.outcome).toBe("failed");
      }),
    ),
  );
});
