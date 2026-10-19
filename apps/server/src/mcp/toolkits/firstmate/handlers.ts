import {
  AGENT_DEFAULT_COLOR,
  AGENT_DEFAULT_ICON,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as FirstmateService from "../../../firstmate/FirstmateService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FirstmateToolkit } from "./tools.ts";

const notAnAgent =
  "This thread has no task board. The task tools act on the board of the agent whose coordinator chat calls them, or whose task the calling worker runs.";
const coordinatorRequired = "Only an agent's coordinator chat may create or update its tasks.";
const agentToolsRequireCoordinator = "Only an agent's coordinator chat may use the agent tools.";
const modelRequired =
  "The calling agent has no recorded model to copy. Pass modelSelection, as orchestrator_capabilities lists it.";

const make = Effect.gen(function* () {
  const firstmate = yield* FirstmateService.FirstmateService;

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

  return {
    agent_list: McpToolAccess.reads(() =>
      requireAgentCoordinator.pipe(
        Effect.andThen(firstmate.listAgents()),
        Effect.map((agents) => ({ agents })),
      ),
    ),
    agent_tasks: McpToolAccess.reads(({ agentId, ...filters }) =>
      requireAgentCoordinator.pipe(Effect.andThen(firstmate.list(agentId, filters))),
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
  } satisfies McpToolAccess.Handlers<typeof FirstmateToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FirstmateToolkit, make);
