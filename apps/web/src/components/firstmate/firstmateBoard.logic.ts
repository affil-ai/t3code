import { firstmateTaskStatus, type FirstmateTask } from "@t3tools/contracts";

export const FIRSTMATE_COLUMN_IDS = [
  "needs-you",
  "backlog",
  "planning",
  "ready",
  "monitoring",
  "in-progress",
  "in-review",
  "hillclimb",
  "done",
] as const;
export type FirstmateColumnId = (typeof FIRSTMATE_COLUMN_IDS)[number];

/**
 * Lifecycle sections in display order, shared by the sidebar and the Tasks
 * panel so the two cannot drift. The sidebar leaves out Done.
 */
export const FIRSTMATE_SECTION_ORDER = [
  "monitoring",
  "ready",
  "planning",
  "in-progress",
  "in-review",
  "hillclimb",
  "backlog",
  "done",
] as const satisfies readonly Exclude<FirstmateColumnId, "needs-you">[];

export type FirstmateBoardColumns = Readonly<Record<FirstmateColumnId, readonly FirstmateTask[]>>;

/** The board keeps this many closed tasks, matching what the server sends. */
export const FIRSTMATE_DONE_LIMIT = 20;

/** Maps explicit status to a lifecycle column, with legacy fallback. */
export function firstmateColumnForTask(task: FirstmateTask): FirstmateColumnId {
  switch (firstmateTaskStatus(task)) {
    case "backlog":
      return "backlog";
    case "planning":
      return "planning";
    case "ready_for_deployment":
      return "ready";
    case "monitoring":
      return "monitoring";
    case "hillclimb":
      return "hillclimb";
    case "in_review":
      return "in-review";
    case "done":
    case "canceled":
      return "done";
    case "in_progress":
      return "in-progress";
  }
}

/** Needs you is an attention view, independent from lifecycle status. */
export function firstmateNeedsYou(task: FirstmateTask): boolean {
  return (
    task.nextActor === "user" &&
    firstmateColumnForTask(task) !== "done" &&
    firstmateColumnForTask(task) !== "backlog"
  );
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
    backlog: [],
    planning: [],
    ready: [],
    monitoring: [],
    "in-progress": [],
    "in-review": [],
    hillclimb: [],
    "needs-you": [],
    done: [],
  };
  for (const task of tasks) {
    columns[firstmateColumnForTask(task)].push(task);
    if (firstmateNeedsYou(task)) columns["needs-you"].push(task);
  }
  for (const column of FIRSTMATE_COLUMN_IDS) {
    columns[column].sort(newestFirst);
  }
  columns.done = columns.done.slice(0, FIRSTMATE_DONE_LIMIT);
  return columns;
}

export function countFirstmateNeedsYou(tasks: readonly FirstmateTask[]): number {
  return tasks.filter(firstmateNeedsYou).length;
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
