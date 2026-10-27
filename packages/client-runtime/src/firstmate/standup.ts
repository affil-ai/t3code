import {
  FIRSTMATE_AGENT_ID,
  type AgentProfile,
  type FirstmateTaskId,
  type StandupItem,
  standupProgress,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

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
 * Tasks panel; an item without a task opens Firstmate, who keeps the list.
 */
export function standupTarget(
  item: StandupItem,
  agents: ReadonlyArray<AgentProfile>,
): StandupTarget | null {
  if (item.task?.workerThreadId != null) {
    return { kind: "thread", threadId: item.task.workerThreadId };
  }
  const ownerId = item.task === null ? FIRSTMATE_AGENT_ID : item.agentId;
  const coordinatorThreadId =
    agents.find((agent) => agent.id === ownerId)?.coordinatorThreadId ?? null;
  if (coordinatorThreadId === null) return null;
  return item.task === null
    ? { kind: "thread", threadId: coordinatorThreadId }
    : { kind: "task", coordinatorThreadId, taskId: item.task.id };
}

/** Items whose task waits on the user; a worker's pending approval shows on its row. */
export function standupNeedsYouCount(items: ReadonlyArray<StandupItem>): number {
  return items.filter((item) => standupProgress(item.task, null) === "needs_you").length;
}

/** "started Oct 27", with the year only when it is not the current one. */
export function standupStartedLabel(startedAt: string, now: Date): string {
  const parsed = DateTime.make(startedAt);
  if (Option.isNone(parsed)) return "";
  const started = DateTime.toDate(parsed.value);
  const date = started.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(started.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `started ${date}`;
}
