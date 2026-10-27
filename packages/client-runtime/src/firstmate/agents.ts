/**
 * Which agent the Work sidebar shows, from the saved choice and the live
 * agent list. A saved id that no longer exists (archived, or another
 * server) falls back the same way as no choice.
 *
 * @module firstmate/agents
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

/**
 * The agents in the user's saved tab order. Agents the saved order does not
 * know (new ones, or ones from before any reorder) follow in server order;
 * saved ids for archived agents are skipped.
 */
export function orderAgents<T extends Pick<AgentProfile, "id">>(
  agents: ReadonlyArray<T>,
  savedOrder: ReadonlyArray<string>,
): T[] {
  if (savedOrder.length === 0) return [...agents];
  const rank = new Map(savedOrder.map((id, index) => [id, index]));
  const known = agents.filter((agent) => rank.has(agent.id));
  known.sort((left, right) => rank.get(left.id)! - rank.get(right.id)!);
  return [...known, ...agents.filter((agent) => !rank.has(agent.id))];
}

/**
 * The tab order after dropping `activeId` on `overId`: the dragged agent takes
 * the target's place and the rest shift toward where it came from. Returns the
 * same array when nothing moves.
 */
export function reorderAgentIds(
  ids: ReadonlyArray<string>,
  activeId: string,
  overId: string | null,
): ReadonlyArray<string> {
  if (overId === null || activeId === overId) return ids;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

/** Where a client keeps its selected agent and tab order. Each client keeps its own. */
export const SELECTED_AGENT_STORAGE_KEY = "t3work:selected-agent:v1";

export interface SelectedAgentData {
  /** The chosen agent id, or null for Firstmate (or the hosted preference). */
  selectedAgentId: string | null;
  /** Without an explicit choice, open the first custom agent instead of Firstmate. */
  preferCustomAgent: boolean;
  /** Agent ids in the user's tab order; empty keeps the server's order. */
  agentOrder: string[];
}

/** Reads a stored selection defensively: anything malformed falls back to the defaults. */
export function sanitizeSelectedAgentData(value: unknown): SelectedAgentData {
  const raw =
    value && typeof value === "object"
      ? (value as { selectedAgentId?: unknown; preferCustomAgent?: unknown; agentOrder?: unknown })
      : {};
  return {
    selectedAgentId:
      typeof raw.selectedAgentId === "string" && raw.selectedAgentId !== ""
        ? raw.selectedAgentId
        : null,
    preferCustomAgent: raw.preferCustomAgent === true,
    agentOrder: Array.isArray(raw.agentOrder)
      ? [
          ...new Set(
            raw.agentOrder.filter((id): id is string => typeof id === "string" && id !== ""),
          ),
        ]
      : [],
  };
}
