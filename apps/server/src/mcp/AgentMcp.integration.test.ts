import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AgentAutomationsToolResult,
  AgentProfileId,
  EnvironmentId,
  FIRSTMATE_AGENT_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as FirstmateHome from "../firstmate/FirstmateHome.ts";
import * as FirstmateService from "../firstmate/FirstmateService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const FM = FIRSTMATE_AGENT_ID;
const coordinator = ThreadId.make("firstmate-coordinator");
const otherCoordinator = ThreadId.make("chief-coordinator");
const external: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("isolated-agent-test"),
  requestNamespace: "external-test",
  thread: undefined,
  client: { sessionId: "external-test", label: "ChatGPT", access: "read-only" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const fullAccess: McpInvocationContext.McpInvocationScope = {
  ...external,
  client: { sessionId: "external-test", label: "ChatGPT", access: "full-access" },
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "ChatGPT", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ChatGPT", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const layerDomains = Layer.mergeAll(FirstmateService.layer, ScheduledTasks.layer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(FirstmateHome.FirstmateHome)({
        migrateLegacyHome: () => Effect.succeed(null),
        migrateAgentsFolder: () => Effect.succeed([]),
        artifactsRoot: "/isolated-test/artifacts",
      }),
      // Any accidental schedule dispatch would fail on these absent methods.
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(
            liveThreadShell(id, {
              runtimeMode: id === otherCoordinator ? "auto" : "full-access",
            }),
          ),
      }),
      Scheduler.layer,
      NodeCrypto.layer,
      Sqlite.layerMemory,
    ),
  ),
);
const layerTest = McpHttpServer.layerFirstmateToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(layerDomains),
);
const call = Effect.fn("agentMcpIntegration.call")(function* (
  name: string,
  args: Record<string, unknown>,
  scope: McpInvocationContext.McpInvocationScope = external,
) {
  const server = yield* McpServer.McpServer;
  return yield* server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
});
const seedAgent = Effect.fn("agentMcpIntegration.seedAgent")(function* (
  name: string,
  threadId: ThreadId | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  const id = AgentProfileId.make(`agent:${name}`);
  yield* sql`
    INSERT INTO firstmate_agent
      (agent_id, slug, name, icon, color, role, coordinator_thread_id, created_at)
    VALUES (${id}, ${name}, ${name}, 'bot', 'sky', 'Review work', ${threadId}, '2026-10-20T00:00:00.000Z')
  `;
  return id;
});
const seedSchedule = Effect.fn("agentMcpIntegration.seedSchedule")(function* (
  threadId: ThreadId | null,
  runtimeMode: RuntimeMode = "auto",
) {
  const schedules = yield* ScheduledTasks.ScheduledTaskService;
  return yield* schedules.upsert({
    title: "Review board",
    prompt: "Review the board.",
    enabled: false,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: ProjectId.make("project:agent"),
    threadId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode,
    interactionMode: "default",
  });
});
const createParams = {
  title: "Ship the board",
  intent: "Build the board.",
  definitionOfDone: "Shipped",
};
const decodeAutomations = Schema.decodeUnknownSync(AgentAutomationsToolResult);
const failure = (result: McpSchema.CallToolResult) => {
  const content = result.content[0];
  return content?.type === "text" ? JSON.parse(content.text) : null;
};

describe("external crew MCP registration", () => {
  it.effect(
    "discovers current and future crew, filters and pages boards, and enforces task ownership",
    () =>
      Effect.gen(function* () {
        const firstmate = yield* FirstmateService.FirstmateService;
        yield* firstmate.setCoordinator(FM, { threadId: coordinator });
        const chief = yield* seedAgent("chief-of-office", otherCoordinator);
        const watchtower = yield* seedAgent("watchtower");
        yield* seedAgent("joan-of-affil");
        yield* seedAgent("make-money-move");
        const { task } = yield* firstmate.create(chief, {
          ...createParams,
          priority: true,
          status: "in_review",
          nextActor: "user",
          nextStep: "Approve the board",
        });
        yield* firstmate.create(chief, { ...createParams, status: "backlog" });
        yield* firstmate.create(watchtower, createParams);
        expect((yield* call("agent_list", { limit: 2 })).structuredContent).toMatchObject({
          agents: [{ id: FM }, { id: chief }],
          nextCursor: 2,
          total: 5,
        });
        expect(
          (yield* call("agent_list", { cursor: 2, limit: 2 })).structuredContent,
        ).toMatchObject({
          agents: [{ id: watchtower }, { name: "joan-of-affil" }],
          nextCursor: 4,
        });
        expect(
          (yield* call("agent_list", { nameContains: "MONEY" })).structuredContent,
        ).toMatchObject({
          agents: [{ name: "make-money-move" }],
          nextCursor: null,
          total: 1,
        });
        expect(
          (yield* call("agent_tasks", {
            agentId: chief,
            status: "in_review",
            priority: true,
            nextActor: "user",
            limit: 1,
          })).structuredContent,
        ).toMatchObject({
          agentId: chief,
          tasks: [
            {
              id: task.id,
              priority: true,
              status: "in_review",
              nextActor: "user",
              nextStep: "Approve the board",
            },
          ],
          total: 1,
          nextCursor: null,
        });
        const boardPage = yield* call("agent_tasks", { agentId: chief, limit: 1 });
        expect(boardPage.structuredContent).toMatchObject({ total: 2, nextCursor: 1 });
        expect(
          (yield* call("agent_tasks", { agentId: chief, cursor: 1, limit: 1 })).structuredContent,
        ).toMatchObject({ total: 2, nextCursor: null });
        expect(
          (yield* call("agent_task_get", { agentId: chief, taskId: task.id })).structuredContent,
        ).toMatchObject({
          task: { id: task.id },
          events: [{ summary: "Task created." }, { summary: "Next step: Approve the board" }],
        });
        const wrongOwner = yield* call("agent_task_get", { agentId: watchtower, taskId: task.id });
        expect(wrongOwner.isError).toBe(true);
        expect(failure(wrongOwner)).toMatchObject({ code: "task_not_found" });
        expect(JSON.stringify(wrongOwner)).not.toContain("Approve the board");
        expect(yield* call("agent_tasks", {}).pipe(Effect.flip)).toMatchObject({
          _tag: "InvalidParams",
          code: -32602,
        });
        expect(yield* call("agent_list", { limit: 101 }).pipe(Effect.flip)).toMatchObject({
          _tag: "InvalidParams",
          code: -32602,
        });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reads and manages only the selected agent's coordinator-bound automations", () =>
    Effect.gen(function* () {
      const firstmate = yield* FirstmateService.FirstmateService;
      const schedules = yield* ScheduledTasks.ScheduledTaskService;
      yield* firstmate.setCoordinator(FM, { threadId: coordinator });
      const other = yield* seedAgent("chief", otherCoordinator);
      const unstarted = yield* seedAgent("future-agent");
      const first = yield* seedSchedule(coordinator);
      const second = yield* seedSchedule(coordinator);
      const foreign = yield* seedSchedule(otherCoordinator);
      yield* seedSchedule(null);
      const list = decodeAutomations(
        (yield* call("agent_automations", {
          agentId: FM,
          enabled: false,
          scheduleType: "interval",
          limit: 1,
        })).structuredContent,
      );
      expect(list).toMatchObject({
        total: 2,
        nextCursor: 1,
        automations: [
          {
            enabled: false,
            lastRunAt: null,
            lastRunStatus: "never",
            lastRunError: null,
            runCount: 0,
          },
        ],
      });
      const next = decodeAutomations(
        (yield* call("agent_automations", {
          agentId: FM,
          cursor: 1,
          limit: 1,
        })).structuredContent,
      );
      expect(next).toMatchObject({ total: 2, nextCursor: null });
      expect(next.automations[0]?.scheduledTaskId).not.toBe(list.automations[0]?.scheduledTaskId);
      expect(
        (yield* call("agent_automations", { agentId: unstarted })).structuredContent,
      ).toMatchObject({ automations: [], total: 0 });
      expect(
        (yield* call("agent_automation_get", { agentId: FM, scheduledTaskId: first.task.id }))
          .structuredContent,
      ).toMatchObject({
        automation: { scheduledTaskId: first.task.id, prompt: "Review the board." },
      });
      for (const name of [
        "agent_automation_get",
        "agent_automation_update",
        "agent_automation_delete",
      ]) {
        const denied = yield* call(
          name,
          { agentId: FM, scheduledTaskId: foreign.task.id },
          fullAccess,
        );
        expect(denied.isError, name).toBe(true);
        expect(failure(denied)).toMatchObject({ code: "task_not_found" });
      }
      const edited = yield* call(
        "agent_automation_update",
        {
          agentId: FM,
          scheduledTaskId: first.task.id,
          title: "Edited automation",
        },
        fullAccess,
      );
      expect(edited.isError).not.toBe(true);
      expect(edited.structuredContent).toMatchObject({
        automation: { title: "Edited automation", enabled: false, boundThreadId: coordinator },
      });
      expect(
        (yield* call(
          "agent_automation_delete",
          {
            agentId: FM,
            scheduledTaskId: second.task.id,
          },
          fullAccess,
        )).structuredContent,
      ).toMatchObject({ deleted: true });
      const rows = (yield* schedules.list()).tasks;
      expect(rows.find((task) => task.id === first.task.id)?.title).toBe("Edited automation");
      expect(rows.some((task) => task.id === second.task.id)).toBe(false);
      expect(rows.find((task) => task.id === foreign.task.id)?.title).toBe("Review board");
      expect(
        (yield* call("agent_automations", { agentId: other })).structuredContent,
      ).toMatchObject({ automations: [{ scheduledTaskId: foreign.task.id }], total: 1 });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "denies missing capability and identity, and never impersonates a coordinator for board writes",
    () =>
      Effect.gen(function* () {
        const firstmate = yield* FirstmateService.FirstmateService;
        yield* firstmate.setCoordinator(FM, { threadId: coordinator });
        const { task } = yield* firstmate.create(FM, createParams);
        const inputs = [
          ["agent_list", {}],
          ["agent_tasks", { agentId: FM }],
          ["agent_task_get", { agentId: FM, taskId: task.id }],
          ["agent_automations", { agentId: FM }],
        ] as const;
        for (const [name, args] of inputs) {
          for (const scope of [
            { ...external, capabilities: new Set<never>() },
            { ...external, client: undefined },
          ]) {
            const denied = yield* call(name, args, scope);
            expect(denied.isError, name).toBe(true);
            expect(failure(denied)).toMatchObject({ code: "capability_denied" });
          }
        }
        expect((yield* call("firstmate_task_create", createParams, fullAccess)).isError).toBe(true);
        expect(
          (yield* call(
            "firstmate_task_update",
            {
              taskId: task.id,
              title: "Hijacked",
              summary: "Changed",
            },
            fullAccess,
          )).isError,
        ).toBe(true);
        expect((yield* firstmate.get(FM, { taskId: task.id })).task.title).toBe(createParams.title);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "denies read-only writes and enforces saved and current coordinator mode ceilings",
    () =>
      Effect.gen(function* () {
        const firstmate = yield* FirstmateService.FirstmateService;
        const schedules = yield* ScheduledTasks.ScheduledTaskService;
        yield* firstmate.setCoordinator(FM, { threadId: coordinator });
        const other = yield* seedAgent("chief", otherCoordinator);
        const bound = yield* seedSchedule(coordinator, "approval-required");
        const above = yield* seedSchedule(otherCoordinator, "full-access");
        const allowed = yield* seedSchedule(otherCoordinator);
        const limited: McpInvocationContext.McpInvocationScope = {
          ...external,
          client: { sessionId: "limited", label: "dot", access: "auto" },
        };
        for (const name of ["agent_automation_update", "agent_automation_delete"]) {
          expect(
            failure(
              yield* call(name, {
                agentId: FM,
                scheduledTaskId: bound.task.id,
                enabled: false,
              }),
            ),
          ).toMatchObject({ code: "capability_denied" });
          expect(
            failure(
              yield* call(
                name,
                {
                  agentId: FM,
                  scheduledTaskId: bound.task.id,
                  enabled: false,
                },
                limited,
              ),
            ),
          ).toMatchObject({ code: "runtime_mode_escalation_denied" });
          expect(
            failure(
              yield* call(
                name,
                {
                  agentId: other,
                  scheduledTaskId: above.task.id,
                  enabled: false,
                },
                limited,
              ),
            ),
          ).toMatchObject({ code: "runtime_mode_escalation_denied" });
        }
        const edited = yield* call(
          "agent_automation_update",
          {
            agentId: other,
            scheduledTaskId: allowed.task.id,
            title: "Allowed at auto",
          },
          limited,
        );
        expect(edited.isError).not.toBe(true);
        expect((yield* schedules.list()).tasks).toHaveLength(3);
        expect((yield* schedules.list()).tasks.every((task) => task.runCount === 0)).toBe(true);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns scheduler history without exposing a webhook endpoint", () =>
    Effect.gen(function* () {
      const firstmate = yield* FirstmateService.FirstmateService;
      const schedules = yield* ScheduledTasks.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      yield* firstmate.setCoordinator(FM, { threadId: coordinator });
      const seeded = yield* seedSchedule(coordinator);
      const { task } = yield* schedules.upsert({
        ...seeded.task,
        schedule: { type: "webhook", signature: null },
      });
      yield* sql`
        UPDATE scheduled_tasks
        SET last_run_at = '2026-10-20T10:00:00.000Z',
            last_run_status = 'failed',
            last_run_error = 'Test dispatch failed',
            run_count = 2
        WHERE task_id = ${task.id}
      `;
      const result = yield* call("agent_automation_get", { agentId: FM, scheduledTaskId: task.id });
      expect(result.structuredContent).toMatchObject({
        automation: {
          schedule: { type: "webhook" },
          lastRunAt: "2026-10-20T10:00:00.000Z",
          lastRunStatus: "failed",
          lastRunError: "Test dispatch failed",
          runCount: 2,
        },
      });
      expect(JSON.stringify(result)).not.toContain("/api/hooks/");
      expect(task.webhook?.path).toBeDefined();
      expect(JSON.stringify(result)).not.toContain(task.webhook!.path);
      expect(
        (yield* call("agent_automations", {
          agentId: FM,
          scheduleType: "fixed_time",
        })).structuredContent,
      ).toMatchObject({ automations: [], total: 0 });
      const missing = yield* call("agent_tasks", { agentId: "another-environment-agent" });
      expect(failure(missing)).toMatchObject({ code: "invalid_request" });
    }).pipe(Effect.provide(layerTest)),
  );
});
