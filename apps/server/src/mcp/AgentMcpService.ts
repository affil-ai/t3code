import {
  type AgentAutomation,
  type AgentAutomationGetToolInput,
  type AgentAutomationUpdateToolInput,
  type AgentAutomationsToolInput,
  type AgentAutomationsToolResult,
  type AgentListToolInput,
  type AgentListToolResult,
  type AgentProfileId,
  type AgentTaskGetToolInput,
  type AgentTasksToolInput,
  type AgentTasksToolResult,
  type FirstmateTaskGetResult,
  OrchestratorMcpFailure,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FirstmateService from "../firstmate/FirstmateService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  assertLiveCaller,
  assertTargetWithinLimits,
  readCaller,
  unavailable,
} from "./threadAccess.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const page = <A>(
  items: ReadonlyArray<A>,
  input: { readonly cursor?: number | undefined; readonly limit?: number | undefined },
) => {
  const start = input.cursor ?? 0;
  const end = start + (input.limit ?? 50);
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? end : null,
    total: items.length,
  };
};

/** Do not copy the scheduler's webhook endpoint: its token starts work. */
const automation = (task: ScheduledTask): AgentAutomation => ({
  scheduledTaskId: task.id,
  title: task.title,
  prompt: task.prompt,
  enabled: task.enabled,
  projectId: task.projectId,
  boundThreadId: task.threadId,
  schedule: task.schedule,
  nextRunAt: task.nextRunAt,
  lastRunAt: task.lastRunAt,
  lastRunStatus: task.lastRunStatus,
  lastRunError: task.lastRunError,
  runCount: task.runCount,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

export class AgentMcpService extends Context.Service<
  AgentMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: AgentListToolInput,
    ) => Effect.Effect<AgentListToolResult, OrchestratorMcpFailure>;
    readonly tasks: (
      scope: McpInvocationScope,
      input: AgentTasksToolInput,
    ) => Effect.Effect<AgentTasksToolResult, OrchestratorMcpFailure>;
    readonly task: (
      scope: McpInvocationScope,
      input: AgentTaskGetToolInput,
    ) => Effect.Effect<FirstmateTaskGetResult, OrchestratorMcpFailure>;
    readonly automations: (
      scope: McpInvocationScope,
      input: AgentAutomationsToolInput,
    ) => Effect.Effect<AgentAutomationsToolResult, OrchestratorMcpFailure>;
    readonly getAutomation: (
      scope: McpInvocationScope,
      input: AgentAutomationGetToolInput,
    ) => Effect.Effect<
      { readonly agentId: AgentProfileId; readonly automation: AgentAutomation },
      OrchestratorMcpFailure
    >;
    readonly updateAutomation: (
      scope: McpInvocationScope,
      input: AgentAutomationUpdateToolInput,
    ) => Effect.Effect<
      { readonly agentId: AgentProfileId; readonly automation: AgentAutomation },
      OrchestratorMcpFailure
    >;
    readonly deleteAutomation: (
      scope: McpInvocationScope,
      input: AgentAutomationGetToolInput,
    ) => Effect.Effect<
      {
        readonly agentId: AgentProfileId;
        readonly scheduledTaskId: ScheduledTask["id"];
        readonly deleted: boolean;
      },
      OrchestratorMcpFailure
    >;
  }
>()("t3/mcp/AgentMcpService") {}

const make = Effect.gen(function* () {
  const firstmate = yield* FirstmateService.FirstmateService;
  const schedules = yield* ScheduledTaskService.ScheduledTaskService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  // An outside client acts under its environment approval, never as a coordinator.
  // Provider credentials retain the existing coordinator-only cross-agent policy.
  const authorize = Effect.fn("AgentMcpService.authorize")(function* (scope: McpInvocationScope) {
    const caller = yield* readCaller().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );
    if (caller.scope.thread === undefined && caller.scope.client !== undefined) return caller;
    if (caller.scope.thread !== undefined) {
      const agent = yield* firstmate
        .agentForThread(caller.scope.thread.threadId)
        .pipe(Effect.mapError(unavailable));
      if (agent?.coordinatorThreadId === caller.scope.thread.threadId) return caller;
    }
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Crew access needs an approved external MCP client or an agent's coordinator chat.",
    });
  });
  const requireAgent = Effect.fn("AgentMcpService.requireAgent")(function* (
    agentId: AgentProfileId,
  ) {
    const agents = yield* firstmate.listAgents().pipe(Effect.mapError(unavailable));
    const agent = agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The agent was not found.",
      });
    }
    return agent;
  });
  const ownedAutomation = Effect.fn("AgentMcpService.ownedAutomation")(function* (
    input: AgentAutomationGetToolInput,
  ) {
    const agent = yield* requireAgent(input.agentId);
    const { tasks } = yield* schedules.list().pipe(Effect.mapError(unavailable));
    const task = tasks.find((task) => task.id === input.scheduledTaskId);
    if (
      agent.coordinatorThreadId === null ||
      task === undefined ||
      task.threadId !== agent.coordinatorThreadId
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "task_not_found",
        message: "The automation was not found on this agent.",
      });
    }
    return { ...task, threadId: agent.coordinatorThreadId };
  });
  const writableAutomation = Effect.fn("AgentMcpService.writableAutomation")(function* (
    scope: McpInvocationScope,
    input: AgentAutomationGetToolInput,
  ) {
    const caller = yield* authorize(scope);
    if (caller.scope.client?.access === "read-only") {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This MCP client was approved for read-only access.",
      });
    }
    yield* assertLiveCaller(caller);
    const task = yield* ownedAutomation(input);
    yield* assertTargetWithinLimits(caller.limits, task);
    // A bound schedule posts into the coordinator's current modes.
    const target = yield* caller.threads
      .getThreadShell(task.threadId)
      .pipe(Effect.mapError(unavailable));
    if (target === null || target.deletedAt !== null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The automation's coordinator thread was not found.",
      });
    }
    yield* assertTargetWithinLimits(caller.limits, target);
    return task;
  });

  return AgentMcpService.of({
    list: Effect.fn("AgentMcpService.list")(function* (scope, input) {
      yield* authorize(scope);
      const agents = yield* firstmate.listAgents().pipe(Effect.mapError(unavailable));
      const result = page(
        agents.filter(
          (agent) =>
            input.nameContains === undefined ||
            agent.name.toLowerCase().includes(input.nameContains.toLowerCase()),
        ),
        input,
      );
      return { agents: result.items, nextCursor: result.nextCursor, total: result.total };
    }),
    tasks: Effect.fn("AgentMcpService.tasks")(function* (scope, input) {
      yield* authorize(scope);
      yield* requireAgent(input.agentId);
      const { tasks } = yield* firstmate
        .list(input.agentId, input)
        .pipe(Effect.mapError(unavailable));
      const result = page(
        tasks.filter(
          (task) =>
            (input.priority === undefined || (task.priority ?? false) === input.priority) &&
            (input.nextActor === undefined || task.nextActor === input.nextActor),
        ),
        input,
      );
      return {
        agentId: input.agentId,
        tasks: result.items,
        nextCursor: result.nextCursor,
        total: result.total,
      };
    }),
    task: Effect.fn("AgentMcpService.task")(function* (scope, input) {
      yield* authorize(scope);
      yield* requireAgent(input.agentId);
      return yield* firstmate.get(input.agentId, input).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "task_not_found",
              message: "The task was not found on this agent.",
            }),
        ),
      );
    }),
    automations: Effect.fn("AgentMcpService.automations")(function* (scope, input) {
      yield* authorize(scope);
      const agent = yield* requireAgent(input.agentId);
      const { tasks } = yield* schedules.list().pipe(Effect.mapError(unavailable));
      const result = page(
        tasks.filter(
          (task) =>
            agent.coordinatorThreadId !== null &&
            task.threadId === agent.coordinatorThreadId &&
            (input.enabled === undefined || task.enabled === input.enabled) &&
            (input.scheduleType === undefined || task.schedule.type === input.scheduleType),
        ),
        input,
      );
      return {
        agentId: agent.id,
        automations: result.items.map(automation),
        nextCursor: result.nextCursor,
        total: result.total,
      };
    }),
    getAutomation: Effect.fn("AgentMcpService.getAutomation")(function* (scope, input) {
      yield* authorize(scope);
      return { agentId: input.agentId, automation: automation(yield* ownedAutomation(input)) };
    }),
    updateAutomation: Effect.fn("AgentMcpService.updateAutomation")(function* (scope, input) {
      const existing = yield* writableAutomation(scope, input);
      const { task } = yield* schedules
        .upsert({
          ...existing,
          id: existing.id,
          requireExisting: true,
          expectedThreadId: existing.threadId,
          title: input.title ?? existing.title,
          prompt: input.prompt ?? existing.prompt,
          schedule: input.schedule ?? existing.schedule,
          enabled: input.enabled ?? existing.enabled,
        })
        .pipe(Effect.mapError(unavailable));
      return { agentId: input.agentId, automation: automation(task) };
    }),
    deleteAutomation: Effect.fn("AgentMcpService.deleteAutomation")(function* (scope, input) {
      const existing = yield* writableAutomation(scope, input);
      yield* schedules
        .delete({
          id: existing.id,
          expectedThreadId: existing.threadId,
        })
        .pipe(Effect.mapError(unavailable));
      return { agentId: input.agentId, scheduledTaskId: existing.id, deleted: true };
    }),
  });
});

export const layer = Layer.effect(AgentMcpService, make);
