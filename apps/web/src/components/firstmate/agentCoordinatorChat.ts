/**
 * Whether a chat is an agent's coordinator chat, for the chat header to leave
 * out the agent's home project. The rule lives in client-runtime.
 *
 * @module agentCoordinatorChat
 */
import { isAgentCoordinatorChat } from "@t3tools/client-runtime/firstmate/chat-lists";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useAgentsHome } from "~/state/agents";

export function useIsAgentCoordinatorChat(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null | undefined,
): boolean {
  return isAgentCoordinatorChat(useAgentsHome(), environmentId, threadId);
}
