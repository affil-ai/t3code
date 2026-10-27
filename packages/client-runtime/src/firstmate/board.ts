/**
 * The Tasks board: lifecycle sections, the Needs-you attention view, and the
 * sidebar's open-task navigation order. Shared by web and mobile so the two
 * cannot drift.
 *
 * @module firstmate/board
 */
import { firstmateTaskStatus, standupTaskOpen, type FirstmateTask } from "@t3tools/contracts";

export const FIRSTMATE_COLUMN_IDS = [
  "needs-you",
  "standup",
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
  "standup",
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

/**
 * Maps explicit status to a lifecycle column, with legacy fallback. An open
 * standup task sits in Standup instead of its status column until it finishes.
 */
export function firstmateColumnForTask(task: FirstmateTask): FirstmateColumnId {
  if (standupTaskOpen(task)) return "standup";
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
    standup: [],
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

/**
 * The sidebar tree's sections: the shared order without Done, and without
 * Standup, whose rows (every agent's, under Firstmate) render above the tree
 * and are left out of arrow-key navigation.
 */
export const OPEN_TASK_COLUMNS = FIRSTMATE_SECTION_ORDER.filter(
  (column): column is Exclude<(typeof FIRSTMATE_SECTION_ORDER)[number], "done" | "standup"> =>
    column !== "done" && column !== "standup",
);

/** Open tasks in sidebar order, each once. */
export function sidebarNavigationTasks(tasks: readonly FirstmateTask[]): FirstmateTask[] {
  const columns = mapFirstmateBoard(tasks);
  const seen = new Set<string>();
  return OPEN_TASK_COLUMNS.flatMap((column) => columns[column]).filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

/** The task before or after `currentId`, wrapping at both ends. */
export function adjacentSidebarTask(
  tasks: readonly FirstmateTask[],
  currentId: string | null,
  direction: "previous" | "next",
): FirstmateTask | null {
  if (tasks.length === 0) return null;
  const index = tasks.findIndex((task) => task.id === currentId);
  if (index < 0) return (direction === "next" ? tasks[0] : tasks.at(-1)) ?? null;
  const offset = direction === "next" ? 1 : -1;
  return tasks[(index + offset + tasks.length) % tasks.length] ?? null;
}
