/**
 * Whether a chat is an agent's coordinator chat. Such a chat runs in its
 * agent's home project, which carries the agent's name, so the chat header
 * leaves the project out rather than show the name twice.
 *
 * @module agentCoordinatorChat
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { type AgentsHome, useAgentsHome } from "~/state/agents";

export function isAgentCoordinatorChat(
  home: AgentsHome | null,
  environmentId: EnvironmentId,
  threadId: ThreadId | null | undefined,
): boolean {
  if (home === null || threadId == null || home.environmentId !== environmentId) return false;
  return home.agents.some((agent) => agent.coordinatorThreadId === threadId);
}

export function useIsAgentCoordinatorChat(
  environmentId: EnvironmentId,
  threadId: ThreadId | null | undefined,
): boolean {
  return isAgentCoordinatorChat(useAgentsHome(), environmentId, threadId);
}
