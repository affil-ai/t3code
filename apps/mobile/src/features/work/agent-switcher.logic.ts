/**
 * How the Work tab names and describes an agent. Firstmate's own stream is
 * authoritative for its name, icon, and chat, as on web: its agent row can
 * trail behind an appearance change or a fresh start.
 */
import type { AgentProfile, FirstmateSnapshot, ThreadId } from "@t3tools/contracts";
import { isFirstmateAgent, reorderAgentIds } from "@t3tools/client-runtime/firstmate/agents";

export interface AgentPresentation {
  readonly name: string;
  readonly icon: string;
  readonly coordinatorThreadId: ThreadId | null;
}

export function agentPresentation(
  agent: AgentProfile,
  firstmate: Pick<FirstmateSnapshot, "name" | "icon" | "coordinatorThreadId"> | null,
): AgentPresentation {
  if (!isFirstmateAgent(agent) || firstmate === null) {
    return { name: agent.name, icon: agent.icon, coordinatorThreadId: agent.coordinatorThreadId };
  }
  return {
    name: firstmate.name,
    icon: firstmate.icon,
    coordinatorThreadId: firstmate.coordinatorThreadId ?? agent.coordinatorThreadId,
  };
}

/** The agent's role on one line, or "Not started" before it has a chat. */
export function agentRoleLine(agent: AgentProfile, coordinatorThreadId: ThreadId | null): string {
  if (coordinatorThreadId === null) return "Not started";
  const role = agent.role.split("\n")[0]?.trim();
  return role || (isFirstmateAgent(agent) ? "Your coordinator" : "Agent");
}

/** The picker draws a grid of avatars once there are more agents than fit as rows. */
export const AGENT_PICKER_ROW_LIMIT = 4;

/**
 * The agent order after moving one agent a place up or down, the phone's
 * stand-in for web's drag to reorder. At either end the order is unchanged.
 */
export function moveAgent(
  ids: ReadonlyArray<string>,
  agentId: string,
  direction: "up" | "down",
): ReadonlyArray<string> {
  const index = ids.indexOf(agentId);
  const neighbour = ids[direction === "up" ? index - 1 : index + 1];
  return index === -1 || neighbour === undefined ? ids : reorderAgentIds(ids, agentId, neighbour);
}
