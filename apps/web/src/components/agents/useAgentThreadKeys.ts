import {
  agentCoordinatorThreadKeys,
  agentHomeProjectKeys,
} from "@t3tools/client-runtime/firstmate/chat-lists";

import { readAgentsHome, useAgentsHome } from "~/state/agents";

/**
 * Every agent's coordinator chat, Firstmate's included, as scoped keys for
 * the Work sidebar list to leave out: those chats have their own
 * rows in Agents mode and under Search. Search still finds them.
 */
export function useAgentCoordinatorThreadKeys(): ReadonlySet<string> {
  const home = useAgentsHome();
  return agentCoordinatorThreadKeys(home);
}

/** Every agent's home project key, for the Work sidebar's new chat to skip. */
export function readAgentHomeProjectKeys(): ReadonlySet<string> {
  return agentHomeProjectKeys(readAgentsHome());
}
