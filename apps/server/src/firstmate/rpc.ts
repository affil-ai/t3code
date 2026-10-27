import {
  FIRSTMATE_AGENT_ID,
  FIRSTMATE_WS_METHODS,
  type AgentArchiveInput,
  type AgentCreateInput,
  type AgentStartInput,
  type AgentTasksSubscribeInput,
  type AgentUpdateInput,
  type AgentsSubscribeInput,
  type FirstmateGetTaskInput,
  type FirstmateSetTaskPriorityInput,
  type FirstmateSetAppearanceInput,
  type FirstmateSetCoordinatorInput,
  type FirstmateStartInput,
  type FirstmateSubscribeInput,
} from "@t3tools/contracts";

import type { FirstmateService } from "./FirstmateService.ts";

/** Firstmate's RPCs act on the reserved agent (getTask reads any board); the `agents.*` RPCs take an agent id. */
export const rpcHandlers = (service: FirstmateService["Service"]) => ({
  [FIRSTMATE_WS_METHODS.firstmateSetTaskPriority]: (input: FirstmateSetTaskPriorityInput) =>
    service.setTaskPriority(input),
  [FIRSTMATE_WS_METHODS.firstmateSubscribe]: (_input: FirstmateSubscribeInput) =>
    service.subscribe(FIRSTMATE_AGENT_ID),
  // Clients already see every agent's board through agents.tasks.subscribe, so a
  // task's history is readable whichever agent owns it.
  [FIRSTMATE_WS_METHODS.firstmateGetTask]: (input: FirstmateGetTaskInput) =>
    service.get(null, input),
  [FIRSTMATE_WS_METHODS.firstmateSetCoordinator]: (input: FirstmateSetCoordinatorInput) =>
    service.setCoordinator(FIRSTMATE_AGENT_ID, input),
  [FIRSTMATE_WS_METHODS.firstmateStart]: (input: FirstmateStartInput) =>
    service.start(FIRSTMATE_AGENT_ID, input),
  [FIRSTMATE_WS_METHODS.firstmateSetAppearance]: (input: FirstmateSetAppearanceInput) =>
    service.setAppearance(FIRSTMATE_AGENT_ID, input),
  [FIRSTMATE_WS_METHODS.agentsSubscribe]: (_input: AgentsSubscribeInput) =>
    service.subscribeAgents(),
  [FIRSTMATE_WS_METHODS.agentTasksSubscribe]: (input: AgentTasksSubscribeInput) =>
    service.subscribe(input.agentId),
  [FIRSTMATE_WS_METHODS.agentCreate]: (input: AgentCreateInput) => service.createAgent(input),
  [FIRSTMATE_WS_METHODS.agentUpdate]: (input: AgentUpdateInput) => service.updateAgent(input),
  [FIRSTMATE_WS_METHODS.agentArchive]: (input: AgentArchiveInput) => service.archiveAgent(input),
  [FIRSTMATE_WS_METHODS.agentStart]: (input: AgentStartInput) => service.startAgent(input),
});

/** `rpc.aggregate` span labels, spread into the server's RpcInstrumentation table. */
export const FIRSTMATE_RPC_AGGREGATES = {
  [FIRSTMATE_WS_METHODS.firstmateSetTaskPriority]: "firstmate",
  [FIRSTMATE_WS_METHODS.firstmateSubscribe]: "firstmate",
  [FIRSTMATE_WS_METHODS.firstmateGetTask]: "firstmate",
  [FIRSTMATE_WS_METHODS.firstmateSetCoordinator]: "firstmate",
  [FIRSTMATE_WS_METHODS.firstmateStart]: "firstmate",
  [FIRSTMATE_WS_METHODS.firstmateSetAppearance]: "firstmate",
  [FIRSTMATE_WS_METHODS.agentsSubscribe]: "agents",
  [FIRSTMATE_WS_METHODS.agentTasksSubscribe]: "agents",
  [FIRSTMATE_WS_METHODS.agentCreate]: "agents",
  [FIRSTMATE_WS_METHODS.agentUpdate]: "agents",
  [FIRSTMATE_WS_METHODS.agentArchive]: "agents",
  [FIRSTMATE_WS_METHODS.agentStart]: "agents",
} as const;
