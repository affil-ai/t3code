import {
  FIRSTMATE_AGENT_ID,
  type AgentProfile,
  type FirstmateTaskId,
  type StandupItem,
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
 * Tasks panel. An item without a task, or whose owner is archived, opens
 * Firstmate, who keeps the list.
 */
export function standupTarget(
  item: StandupItem,
  agents: ReadonlyArray<AgentProfile>,
): StandupTarget | null {
  if (item.task?.workerThreadId != null) {
    return { kind: "thread", threadId: item.task.workerThreadId };
  }
  const chatOf = (agentId: string | null) =>
    agents.find((agent) => agent.id === agentId)?.coordinatorThreadId ?? null;
  const ownerChat = item.task === null ? null : chatOf(item.agentId);
  if (item.task !== null && ownerChat !== null) {
    return { kind: "task", coordinatorThreadId: ownerChat, taskId: item.task.id };
  }
  const firstmateChat = chatOf(FIRSTMATE_AGENT_ID);
  return firstmateChat === null ? null : { kind: "thread", threadId: firstmateChat };
}

/** Items whose task waits on the user; a worker's pending approval shows on its row. */
export function standupNeedsYouCount(items: ReadonlyArray<StandupItem>): number {
  return items.filter((item) => standupProgress(item.task, null) === "needs_you").length;
}

/** "started Oct 27", with the year only when it is not the current one. */
export function standupStartedLabel(startedAt: string, now: Date): string {
  const started = new Date(startedAt);
  if (Number.isNaN(started.getTime())) return "";
  const date = started.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(started.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `started ${date}`;
}
