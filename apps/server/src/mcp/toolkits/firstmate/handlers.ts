import {
  FIRSTMATE_AGENT_ID,
  AGENT_DEFAULT_COLOR,
  AGENT_DEFAULT_ICON,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as FirstmateService from "../../../firstmate/FirstmateService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as AgentMcpService from "../../AgentMcpService.ts";
import { FirstmateToolkit } from "./tools.ts";

const notAnAgent =
  "This thread has no task board. The task tools act on the board of the agent whose coordinator chat calls them, or whose task the calling worker runs.";
const coordinatorRequired = "Only an agent's coordinator chat may create or update its tasks.";
const workerRequired = "Only a task's worker chat may report its progress.";
const agentToolsRequireCoordinator = "Only an agent's coordinator chat may use the agent tools.";
const firstmateRequired = "Only Firstmate's coordinator chat may change the standup list.";
const modelRequired =
  "The calling agent has no recorded model to copy. Pass modelSelection, as orchestrator_capabilities lists it.";

const make = Effect.gen(function* () {
  const firstmate = yield* FirstmateService.FirstmateService;
  const agents = yield* AgentMcpService.AgentMcpService;

  /** The agent the calling thread acts for: its coordinator, or a worker on one of its tasks. */
  const callingAgent = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = scope.thread;
    if (thread === undefined) {
      return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: notAnAgent });
    }
    const agent = yield* firstmate.agentForThread(thread.threadId);
    if (agent === null) {
      return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: notAnAgent });
    }
    return { agent, threadId: thread.threadId };
  });
  /** The calling coordinator's agent; a worker may read its agent's board but not change it. */
  const requireCoordinator = callingAgent.pipe(
    Effect.flatMap(({ agent, threadId }) =>
      agent.coordinatorThreadId === threadId
        ? Effect.succeed(agent)
        : new OrchestratorMcpFailure({ code: "capability_denied", message: coordinatorRequired }),
    ),
  );

  /** The agent tools act across agents, so a worker may not call them. */
  const requireAgentCoordinator = callingAgent.pipe(
    Effect.flatMap(({ agent, threadId }) =>
      agent.coordinatorThreadId === threadId
        ? Effect.succeed(agent)
        : new OrchestratorMcpFailure({
            code: "capability_denied",
            message: agentToolsRequireCoordinator,
          }),
    ),
  );

  /** The standup is the user's one list; only Firstmate's coordinator keeps it. */
  const requireFirstmateCoordinator = requireCoordinator.pipe(
    Effect.flatMap((agent) =>
      agent.id === FIRSTMATE_AGENT_ID
        ? Effect.succeed(agent)
        : new OrchestratorMcpFailure({ code: "capability_denied", message: firstmateRequired }),
    ),
  );

  return {
    standup_add: McpToolAccess.writes((input) =>
      requireFirstmateCoordinator.pipe(
        Effect.flatMap((agent) => firstmate.addStandupItem(agent.id, input)),
      ),
    ),
    standup_update: McpToolAccess.writes((input) =>
      requireFirstmateCoordinator.pipe(
        Effect.flatMap((agent) => firstmate.updateStandupItem(agent.id, input)),
      ),
    ),
    standup_archive: McpToolAccess.writes((input) =>
      requireFirstmateCoordinator.pipe(Effect.andThen(firstmate.archiveStandupItem(input))),
    ),
    standup_list: McpToolAccess.reads((input) =>
      callingAgent.pipe(Effect.andThen(firstmate.listStandup(input))),
    ),
    agent_list: McpToolAccess.reads((input) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => agents.list(scope, input)),
      ),
    ),
    agent_tasks: McpToolAccess.reads((input) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => agents.tasks(scope, input)),
      ),
    ),
    agent_task_get: McpToolAccess.reads((input) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => agents.task(scope, input)),
      ),
    ),
    agent_automations: McpToolAccess.reads((input) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => agents.automations(scope, input)),
      ),
    ),
    agent_automation_get: McpToolAccess.reads((input) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => agents.getAutomation(scope, input)),
      ),
    ),
    agent_automation_update: McpToolAccess.writes((input) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => agents.updateAutomation(scope, input)),
      ),
    ),
    agent_automation_delete: McpToolAccess.writes((input) =>
      McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => agents.deleteAutomation(scope, input)),
      ),
    ),
    agent_create: McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const caller = yield* requireAgentCoordinator;
        const modelSelection = input.modelSelection ?? caller.modelSelection;
        if (modelSelection === null) {
          return yield* new OrchestratorMcpFailure({
            code: "model_unavailable",
            message: modelRequired,
          });
        }
        return yield* firstmate.createAgent({
          name: input.name,
          role: input.role,
          icon: input.icon ?? AGENT_DEFAULT_ICON,
          color: input.color ?? AGENT_DEFAULT_COLOR,
          ...(input.avatarAttachmentId === undefined
            ? {}
            : { avatarAttachmentId: input.avatarAttachmentId }),
          modelSelection,
        });
      }),
    ),
    agent_update: McpToolAccess.writes((input) =>
      requireAgentCoordinator.pipe(Effect.andThen(firstmate.updateAgent(input))),
    ),
    firstmate_task_list: McpToolAccess.reads((input) =>
      callingAgent.pipe(Effect.flatMap(({ agent }) => firstmate.list(agent.id, input))),
    ),
    firstmate_task_get: McpToolAccess.reads((input) =>
      callingAgent.pipe(Effect.flatMap(({ agent }) => firstmate.get(agent.id, input))),
    ),
    firstmate_task_create: McpToolAccess.writes((input) =>
      requireCoordinator.pipe(Effect.flatMap((agent) => firstmate.create(agent.id, input))),
    ),
    firstmate_task_update: McpToolAccess.writes((input) =>
      requireCoordinator.pipe(Effect.flatMap((agent) => firstmate.update(agent.id, input))),
    ),
    task_report_progress: McpToolAccess.writes((input) =>
      Effect.gen(function* () {
        const { thread } = yield* McpInvocationContext.McpInvocationContext;
        if (thread === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: workerRequired,
          });
        }
        return yield* firstmate.reportProgress(thread.threadId, input);
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof FirstmateToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FirstmateToolkit, make);
