import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  EnvironmentId,
  FIRSTMATE_AGENT_ID,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as FirstmateHome from "../../../firstmate/FirstmateHome.ts";
import * as FirstmateService from "../../../firstmate/FirstmateService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as FirstmateHandlers from "./handlers.ts";
import { FirstmateToolkit } from "./tools.ts";

const FM = FIRSTMATE_AGENT_ID;

const COORDINATOR = ThreadId.make("coordinator");
const WORKER = ThreadId.make("worker");

const invocation = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: `session-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 1,
});

const makeHarness = Effect.fn("firstmateToolkitTestHarness")(function* () {
  const layerFirstmate = FirstmateService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(FirstmateHome.FirstmateHome)({
          migrateLegacyHome: () => Effect.succeed(null),
          migrateAgentsFolder: () => Effect.succeed([]),
          artifactsRoot: "/agents/artifacts",
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        NodeCrypto.layer,
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ),
    ),
  );
  const layerDependencies = Layer.mergeAll(
    yield* Layer.build(layerFirstmate).pipe(Effect.map(Layer.succeedContext)),
    McpToolAccessTestkit.liveThreadsLayer,
  );
  const service = yield* FirstmateService.FirstmateService.pipe(Effect.provide(layerDependencies));
  yield* service.setCoordinator(FM, { threadId: COORDINATOR });
  const toolkit = yield* FirstmateToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(FirstmateHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );
  /** The last streamed result; the toolkit returns failures as results. */
  const call = <Name extends keyof typeof FirstmateToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    caller: ThreadId,
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(caller)),
      Effect.provide(layerDependencies),
    );
  return { service, call };
});

const createParams = {
  title: "Ship the board",
  intent: "Build the board.",
  definitionOfDone: "The board ships.",
};

describe("Firstmate toolkit handlers", () => {
  it.effect("refuses task creation from a thread that is not the coordinator", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.call("firstmate_task_create", createParams, WORKER);
        expect(result.isFailure).toBe(true);
        expect(result.result).toMatchObject({
          _tag: "OrchestratorMcpFailure",
          code: "capability_denied",
        });
        expect((yield* harness.service.list(FM)).tasks).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses task updates from a thread that is not the coordinator", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { task } = yield* harness.service.create(FM, createParams);
        const result = yield* harness.call(
          "firstmate_task_update",
          { taskId: task.id, summary: "Renamed.", title: "Hijacked" },
          WORKER,
        );
        expect(result.isFailure).toBe(true);
        expect(result.result).toMatchObject({ code: "capability_denied" });
        expect((yield* harness.service.get(FM, { taskId: task.id })).task.title).toBe(
          "Ship the board",
        );
      }),
    ),
  );

  it.effect("lets the coordinator create and update tasks", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const created = yield* harness.call("firstmate_task_create", createParams, COORDINATOR);
        expect(created.isFailure).toBe(false);
        const [task] = (yield* harness.service.list(FM)).tasks;
        const updated = yield* harness.call(
          "firstmate_task_update",
          { taskId: task!.id, summary: "Waiting on review.", state: "waiting" },
          COORDINATOR,
        );
        expect(updated.isFailure).toBe(false);
        expect((yield* harness.service.get(FM, { taskId: task!.id })).task.state).toBe("waiting");
      }),
    ),
  );

  it.effect("lets a worker on one of the agent's tasks read the board, and refuses strangers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const stranger = yield* harness.call("firstmate_task_list", {}, WORKER);
        expect(stranger.isFailure).toBe(true);
        const { task } = yield* harness.service.create(FM, {
          ...createParams,
          workerThreadId: WORKER,
        });
        const listed = yield* harness.call("firstmate_task_list", {}, WORKER);
        expect(listed.isFailure).toBe(false);
        expect(listed.result).toMatchObject({ tasks: [{ id: task.id }] });
        const got = yield* harness.call("firstmate_task_get", { taskId: task.id }, WORKER);
        expect(got.isFailure).toBe(false);
        expect(got.result).toMatchObject({
          task: { id: task.id },
          events: [{ summary: "Task created." }],
        });
      }),
    ),
  );

  it.effect("lets a coordinator list agents and read a board, and refuses workers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const { task } = yield* harness.service.create(FM, {
          ...createParams,
          workerThreadId: WORKER,
        });
        const listed = yield* harness.call("agent_list", {}, COORDINATOR);
        expect(listed.isFailure).toBe(false);
        expect(listed.result).toMatchObject({
          agents: [{ id: FM, coordinatorThreadId: COORDINATOR }],
        });
        const board = yield* harness.call("agent_tasks", { agentId: FM }, COORDINATOR);
        expect(board.isFailure).toBe(false);
        expect(board.result).toMatchObject({ tasks: [{ id: task.id }] });
        // A worker may read its own agent's board through the task tools, not the agent tools.
        for (const result of [
          yield* harness.call("agent_list", {}, WORKER),
          yield* harness.call("agent_tasks", { agentId: FM }, WORKER),
        ]) {
          expect(result.isFailure).toBe(true);
          expect(result.result).toMatchObject({ code: "capability_denied" });
        }
      }),
    ),
  );

  it.effect("asks for a model when creating an agent and the caller has none recorded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.call(
          "agent_create",
          { name: "Scout", role: "Watches things." },
          COORDINATOR,
        );
        expect(result.isFailure).toBe(true);
        expect(result.result).toMatchObject({ code: "model_unavailable" });
        expect(yield* harness.service.listAgents()).toHaveLength(1);
      }),
    ),
  );
});
