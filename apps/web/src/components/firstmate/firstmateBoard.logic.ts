import type { FirstmateTask } from "@t3tools/contracts";

export const FIRSTMATE_COLUMN_IDS = [
  "needs-you",
  "ready",
  "planning",
  "in-progress",
  "in-review",
  "done",
] as const;
export type FirstmateColumnId = (typeof FIRSTMATE_COLUMN_IDS)[number];

export type FirstmateBoardColumns = Readonly<Record<FirstmateColumnId, readonly FirstmateTask[]>>;

/** The board keeps this many closed tasks, matching what the server sends. */
export const FIRSTMATE_DONE_LIMIT = 20;

/**
 * The one column a task belongs to. The design's column rules overlap, so they
 * apply in this order:
 *
 * 1. Done: the task is done or dropped, whoever was last named to act.
 * 2. Ready for deployment: reviewed and green (state `ready`). Only the user's
 *    merge or deploy remains, so it stays out of Needs you, which is for
 *    decisions.
 * 3. Planning: an open or waiting task that has no worker yet. It leaves the
 *    column the moment a worker chat is recorded, whoever acts next.
 * 4. Needs you: the user acts next, even on a waiting task, so the board
 *    never hides a decision behind a waiting state.
 * 5. In review: the task is waiting on reviews or checks (state `waiting`), or
 *    someone outside acts next.
 * 6. In progress: the worker or the coordinator acts next.
 */
export function firstmateColumnForTask(task: FirstmateTask): FirstmateColumnId {
  if (task.state === "done" || task.state === "dropped") return "done";
  if (task.state === "ready") return "ready";
  if (task.workerThreadId === null) return "planning";
  if (task.nextActor === "user") return "needs-you";
  if (task.state === "waiting" || task.nextActor === "external") return "in-review";
  return "in-progress";
}

function timestamp(value: string | null): number {
  if (value === null) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** When the task last moved: its close time once closed, otherwise its last update. */
export function firstmateTaskActivityAt(task: FirstmateTask): string {
  return task.closedAt ?? task.updatedAt;
}

function newestFirst(left: FirstmateTask, right: FirstmateTask): number {
  return (
    timestamp(firstmateTaskActivityAt(right)) - timestamp(firstmateTaskActivityAt(left)) ||
    left.id.localeCompare(right.id)
  );
}

/** Groups tasks into columns, newest activity first, keeping the latest closed tasks. */
export function mapFirstmateBoard(tasks: readonly FirstmateTask[]): FirstmateBoardColumns {
  const columns: Record<FirstmateColumnId, FirstmateTask[]> = {
    "needs-you": [],
    ready: [],
    planning: [],
    "in-progress": [],
    "in-review": [],
    done: [],
  };
  for (const task of tasks) {
    columns[firstmateColumnForTask(task)].push(task);
  }
  for (const column of FIRSTMATE_COLUMN_IDS) {
    columns[column].sort(newestFirst);
  }
  columns.done = columns.done.slice(0, FIRSTMATE_DONE_LIMIT);
  return columns;
}

/**
 * Tasks waiting on a decision from the user: the Needs you column, plus a
 * task still being planned whose next actor is the user, so the badge does
 * not drop a decision because no worker has started.
 */
export function countFirstmateNeedsYou(tasks: readonly FirstmateTask[]): number {
  let count = 0;
  for (const task of tasks) {
    const column = firstmateColumnForTask(task);
    if (column === "needs-you" || (column === "planning" && task.nextActor === "user")) count += 1;
  }
  return count;
}

export function countFirstmateOpenTasks(tasks: readonly FirstmateTask[]): number {
  let count = 0;
  for (const task of tasks) {
    if (firstmateColumnForTask(task) !== "done") count += 1;
  }
  return count;
}

/** True for links that point at a pull or merge request, which get the PR icon. */
export function isPullRequestUrl(url: string): boolean {
  return /\/(pull|pulls|merge_requests)\/\d+/.test(url);
}

/** True for links into a Slack workspace, which get the Slack icon. */
export function isSlackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "slack.com" || host.endsWith(".slack.com");
  } catch {
    return false;
  }
}
