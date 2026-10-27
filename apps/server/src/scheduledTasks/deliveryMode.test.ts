import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { ensureDeliveryModeColumn } from "./deliveryModeColumn.ts";
import { steerSendMode } from "./deliveryMode.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const runId = RunId.make("delivery-run");
const attemptId = RunAttemptId.make("delivery-attempt");
const providerThreadId = ProviderThreadId.make("delivery-provider-thread");
const providerSessionId = ProviderSessionId.make("delivery-provider-session");

type SendModeProjection = Parameters<typeof steerSendMode>[0];

/** A thread whose latest run is mid-turn on a provider with the given capabilities. */
function busyProjection(
  capabilities: OrchestrationV2ProviderCapabilities,
  nodes: ReadonlyArray<Pick<OrchestrationV2ExecutionNode, "kind" | "status">> = [],
): SendModeProjection {
  return {
    runs: [
      {
        id: runId,
        status: "running",
        ordinal: 1,
        activeAttemptId: attemptId,
        providerThreadId,
      },
    ],
    providerTurns: [{ runAttemptId: attemptId, status: "running" }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    providerSessions: [{ id: providerSessionId, capabilities }],
    nodes: nodes.map((node) => ({ ...node, runId })),
  } as unknown as SendModeProjection;
}

const idleProjection = {
  runs: [],
  providerTurns: [],
  providerThreads: [],
  providerSessions: [],
  nodes: [],
} as unknown as SendModeProjection;

it("steers a busy turn unless its provider's steering would cancel an open tool", () => {
  assert.equal(steerSendMode(idleProjection), "auto");
  assert.equal(
    steerSendMode(
      busyProjection(CodexProviderCapabilitiesV2, [{ kind: "tool_call", status: "running" }]),
    ),
    "auto",
  );
  assert.equal(steerSendMode(busyProjection(ClaudeProviderCapabilitiesV2)), "auto");
  assert.equal(
    steerSendMode(
      busyProjection(ClaudeProviderCapabilitiesV2, [{ kind: "tool_call", status: "completed" }]),
    ),
    "auto",
  );
  assert.equal(
    steerSendMode(
      busyProjection(ClaudeProviderCapabilitiesV2, [{ kind: "tool_call", status: "running" }]),
    ),
    "queue",
  );
  assert.equal(
    steerSendMode(
      busyProjection(ClaudeProviderCapabilitiesV2, [
        { kind: "approval_request", status: "waiting" },
      ]),
    ),
    "queue",
  );
});

it.effect("adds the column so existing tasks steer, and is safe to run again", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
      task_id: "existing",
      title: "task",
      prompt: "Run",
      enabled: 1,
      schedule_json: '{"type":"interval","everyMs":60000}',
      project_id: "project",
      thread_id: "thread",
      workspace_strategy_json: '{"type":"root"}',
      model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_by: "user",
      creation_source: "web",
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z",
      next_run_at: null,
      last_run_at: null,
      last_run_status: "never",
      last_run_error: null,
      run_count: 0,
    })}`;
    yield* ensureDeliveryModeColumn;
    yield* ensureDeliveryModeColumn;
    const rows = yield* sql<{ delivery_mode: string }>`SELECT delivery_mode FROM scheduled_tasks`;
    assert.deepEqual(rows, [{ delivery_mode: "steer" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("defaults to steer and sends each mode to the bound thread", () =>
  Effect.gen(function* () {
    const sends = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
      [],
    );
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getProjectThreadRecords: () => Effect.succeed(idleProjection as never),
        sendToThread: (input) =>
          Ref.update(sends, (values) => [...values, input]).pipe(
            Effect.as({} as ThreadManagementService.ThreadManagementSendResult),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const input = yield* decodeUpsertInput({
        title: "Check inbox",
        prompt: "Check the inbox.",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: "project-delivery",
        threadId: "thread-delivery",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const { task } = yield* service.upsert(input);
      assert.equal(task.deliveryMode, "steer");
      yield* service.runNow({ id: task.id });

      const queued = yield* service.upsert({ ...input, id: task.id, deliveryMode: "queue" });
      assert.equal(queued.task.deliveryMode, "queue");
      // An edit that omits the mode keeps it.
      const edited = yield* service.upsert({ ...input, id: task.id, title: "Renamed" });
      assert.equal(edited.task.deliveryMode, "queue");
      yield* service.runNow({ id: task.id });

      assert.deepEqual(
        (yield* Ref.get(sends)).map((send) => send.mode),
        ["auto", "queue"],
      );
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
