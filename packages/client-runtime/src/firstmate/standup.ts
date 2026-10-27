/**
 * The Standup section's rows and where each leads, shared by the web sidebar
 * and the mobile Work tab.
 *
 * @module firstmate/standup
 */
import {
  FIRSTMATE_AGENT_ID,
  type AgentProfile,
  type AgentProfileId,
  type FirstmateTask,
  type FirstmateTaskId,
  type ThreadId,
} from "@t3tools/contracts";

/** Where a standup row leads: the work, wherever it lives. */
export type StandupTarget =
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | {
      readonly kind: "task";
      readonly coordinatorThreadId: ThreadId;
      readonly taskId: FirstmateTaskId;
    };

/**
 * The task's worker chat; else the owner's chat with the task open in its
 * Tasks panel. When the owner is archived, Firstmate's chat, since Firstmate
 * keeps the standup.
 */
export function standupTarget(
  task: FirstmateTask,
  ownerId: AgentProfileId,
  agents: ReadonlyArray<AgentProfile>,
): StandupTarget | null {
  if (task.workerThreadId !== null) return { kind: "thread", threadId: task.workerThreadId };
  const chatOf = (agentId: AgentProfileId) =>
    agents.find((agent) => agent.id === agentId)?.coordinatorThreadId ?? null;
  const ownerChat = chatOf(ownerId);
  if (ownerChat !== null) return { kind: "task", coordinatorThreadId: ownerChat, taskId: task.id };
  const firstmateChat = chatOf(FIRSTMATE_AGENT_ID);
  return firstmateChat === null ? null : { kind: "thread", threadId: firstmateChat };
}

/**
 * The Standup section's rows for the selected agent. Firstmate keeps the
 * standup, so its section lists every agent's tasks; another agent's lists
 * its own. Rows come from the cross-board standup list, never one board's
 * Standup column, which holds only that board's tasks.
 */
export function standupRowsForAgent<
  Row extends { readonly agent: { readonly id: AgentProfileId } },
>(rows: ReadonlyArray<Row>, agentId: AgentProfileId): ReadonlyArray<Row> {
  return agentId === FIRSTMATE_AGENT_ID ? rows : rows.filter((row) => row.agent.id === agentId);
}
