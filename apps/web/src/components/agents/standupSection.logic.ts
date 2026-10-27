import {
  FIRSTMATE_AGENT_ID,
  type AgentProfile,
  type AgentProfileId,
  type FirstmateTask,
  type FirstmateTaskId,
  standupProgress,
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

/** Tasks waiting on the user; a worker's pending approval shows on its row. */
export function standupNeedsYouCount(tasks: ReadonlyArray<FirstmateTask>): number {
  return tasks.filter((task) => standupProgress(task, null) === "needs_you").length;
}
