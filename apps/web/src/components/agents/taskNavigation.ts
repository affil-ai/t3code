import type { FirstmateTask } from "@t3tools/contracts";
import { FIRSTMATE_SECTION_ORDER, mapFirstmateBoard } from "../firstmate/firstmateBoard.logic";

/**
 * The sidebar tree's sections: the shared order without Done, and without
 * Standup, whose rows (every agent's, under Firstmate) render above the tree
 * and are left out of arrow-key navigation.
 */
export const OPEN_TASK_COLUMNS = FIRSTMATE_SECTION_ORDER.filter(
  (column): column is Exclude<(typeof FIRSTMATE_SECTION_ORDER)[number], "done" | "standup"> =>
    column !== "done" && column !== "standup",
);

export function sidebarNavigationTasks(tasks: readonly FirstmateTask[]): FirstmateTask[] {
  const columns = mapFirstmateBoard(tasks);
  const seen = new Set<string>();
  return OPEN_TASK_COLUMNS.flatMap((column) => columns[column]).filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

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
