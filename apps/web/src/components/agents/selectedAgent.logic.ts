/**
 * Which agent the Work sidebar shows, from the saved choice and the live
 * agent list. A saved id that no longer exists (archived, or another
 * server) falls back the same way as no choice.
 */
import { type AgentProfile, FIRSTMATE_AGENT_ID } from "@t3tools/contracts";

export function resolveSelectedAgent(
  agents: ReadonlyArray<AgentProfile>,
  selectedAgentId: string | null,
  preferCustomAgent: boolean,
): AgentProfile | null {
  if (agents.length === 0) return null;
  const chosen =
    selectedAgentId === null ? undefined : agents.find((agent) => agent.id === selectedAgentId);
  if (chosen !== undefined) return chosen;
  const firstmate = agents.find((agent) => agent.id === FIRSTMATE_AGENT_ID) ?? null;
  if (preferCustomAgent) {
    return agents.find((agent) => agent.id !== FIRSTMATE_AGENT_ID) ?? firstmate;
  }
  return firstmate ?? agents[0] ?? null;
}

export function isFirstmateAgent(agent: Pick<AgentProfile, "id"> | null): boolean {
  return agent !== null && agent.id === FIRSTMATE_AGENT_ID;
}
