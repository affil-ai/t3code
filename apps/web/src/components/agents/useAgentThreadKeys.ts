import { agentHomeProjectKeys } from "@t3tools/client-runtime/firstmate/chat-lists";

import { readAgentsHome } from "~/state/agents";

export { useAgentCoordinatorThreadKeys } from "~/state/agents";

/** Every agent's home project key, for the Work sidebar's new chat to skip. */
export function readAgentHomeProjectKeys(): ReadonlySet<string> {
  return agentHomeProjectKeys(readAgentsHome());
}
