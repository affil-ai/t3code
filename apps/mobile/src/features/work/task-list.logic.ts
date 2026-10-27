/**
 * How the Work tab lays out an agent's board: the open sections in the
 * shared order, each task's row text, and the automations bound to the
 * agent's chat. The board's lifecycle rules live in client-runtime; this
 * file only decides what the mobile list shows.
 */
import {
  FIRSTMATE_SECTION_ORDER,
  firstmateNeedsYou,
  mapFirstmateBoard,
} from "@t3tools/client-runtime/firstmate/board";
import { firstmateProgressView } from "@t3tools/client-runtime/firstmate/progress";
import {
  COLUMN_LABELS,
  taskNextStep,
  taskStatusLabel,
} from "@t3tools/client-runtime/firstmate/tasks";
import type { FirstmateTask, ScheduledTask, ThreadId } from "@t3tools/contracts";

import { formatScheduledTaskInterval } from "../settings/scheduledTaskPresentation";

export type TaskListColumn = (typeof FIRSTMATE_SECTION_ORDER)[number];

export interface TaskListSection {
  readonly column: TaskListColumn;
  readonly label: string;
  /** Every task in the section, shown or not. */
  readonly count: number;
  /** Backlog folds, as on web's sidebar; Done folds, as on web's Tasks panel. */
  readonly collapsible: boolean;
  readonly open: boolean;
  /** The rows to draw; empty while the section is folded. */
  readonly tasks: ReadonlyArray<FirstmateTask>;
}

/**
 * The board's sections in the shared order, leaving out empty ones and
 * Standup, which `StandupSection` draws above them from every board. Backlog
 * and Done start folded; Done holds the most recently closed tasks, so a
 * closed task can still be opened and reopened from the phone.
 */
export function buildTaskListSections(
  tasks: ReadonlyArray<FirstmateTask>,
  options: { readonly backlogOpen: boolean; readonly doneOpen: boolean },
): ReadonlyArray<TaskListSection> {
  const columns = mapFirstmateBoard(tasks);
  return FIRSTMATE_SECTION_ORDER.filter(
    (column) => column !== "standup" && columns[column].length > 0,
  ).map((column) => {
    const collapsible = column === "backlog" || column === "done";
    const open =
      column === "backlog" ? options.backlogOpen : column === "done" ? options.doneOpen : true;
    return {
      column,
      label: COLUMN_LABELS[column],
      count: columns[column].length,
      collapsible,
      open,
      tasks: open ? columns[column] : [],
    };
  });
}

export interface TaskRowPresentation {
  readonly needsYou: boolean;
  readonly priority: boolean;
  /** The coordinator's next step, or who has the ball when it wrote none. */
  readonly detail: string;
  /** One short progress line, or null without a measurement. */
  readonly progress: string | null;
  /** Done out of the total, 0 to 1, for a count with a target. */
  readonly progressFraction: number | null;
}

/** What one task row says under its title. */
export function taskRowPresentation(task: FirstmateTask): TaskRowPresentation {
  const view = firstmateProgressView(task);
  return {
    needsYou: firstmateNeedsYou(task),
    priority: task.priority === true,
    detail: taskNextStep(task) ?? taskStatusLabel(task),
    // A metric's baseline and target belong to the detail; the row keeps the reading.
    progress:
      view === null
        ? null
        : view.kind === "metric"
          ? (view.text.split(" · ")[0] ?? null)
          : view.text,
    progressFraction: view?.kind === "count" ? view.fraction : null,
  };
}

/** The scheduled tasks that post into the agent's chat, by title. */
export function coordinatorAutomations(
  tasks: ReadonlyArray<ScheduledTask>,
  threadId: ThreadId,
): ReadonlyArray<ScheduledTask> {
  // A filtered copy sorted in place: Hermes ships no `toSorted`.
  return tasks
    .filter((task) => task.threadId === threadId)
    .sort((left, right) => left.title.localeCompare(right.title));
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Weekdays at 09:00", "Every 15 minutes", "On webhook". */
export function automationScheduleLabel(schedule: ScheduledTask["schedule"]): string {
  if (schedule.type === "webhook") return "On webhook";
  if (schedule.type === "interval") return formatScheduledTaskInterval(schedule.everyMs);
  const weekdays = [...new Set(schedule.weekdays ?? [])].sort((a, b) => a - b);
  const days =
    weekdays.length === 0 || weekdays.length === 7
      ? "Daily"
      : weekdays.length === 5 && weekdays.every((day) => day >= 1 && day <= 5)
        ? "Weekdays"
        : weekdays.map((day) => WEEKDAY_LABELS[day] ?? "?").join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}
