/**
 * What the Tasks panel's list and task detail share: the coordinator thread
 * the panel sits beside, and how columns, states, and actors read.
 *
 * @module firstmateTasksShared
 */
import {
  firstmateTaskStatus,
  type FirstmateTask,
  type FirstmateTaskEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { createContext } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { FirstmateColumnId } from "./firstmateBoard.logic";

/** The coordinator chat beside the panel; artifact images are signed against it. */
export const CoordinatorThreadContext = createContext<ThreadId | null>(null);

export const COLUMN_LABELS: Record<FirstmateColumnId, string> = {
  standup: "Standup",
  backlog: "Backlog",
  "needs-you": "Needs you",
  ready: "Ready for deployment",
  monitoring: "Monitoring",
  planning: "Planning",
  "in-progress": "In progress",
  "in-review": "In review",
  hillclimb: "Hillclimb",
  done: "Done",
};

export const COLUMN_EMPTY: Record<Exclude<FirstmateColumnId, "done">, string> = {
  standup: "Nothing on the standup",
  backlog: "Nothing in backlog",
  "needs-you": "Nothing needs you",
  ready: "Nothing ready to deploy",
  monitoring: "Nothing being monitored",
  planning: "Nothing being planned",
  "in-progress": "Nothing in progress",
  "in-review": "Nothing in review",
  hillclimb: "No hillclimbs running",
};

/** A small dot per column; it is the board's only color. */
export const COLUMN_DOT: Record<FirstmateColumnId, string> = {
  standup: "bg-primary",
  backlog: "bg-muted-foreground/40",
  "needs-you": "bg-warning",
  ready: "bg-success",
  monitoring: "bg-success/50",
  planning: "bg-primary/60",
  "in-progress": "bg-info",
  "in-review": "bg-muted-foreground/60",
  hillclimb: "bg-info/50",
  done: "bg-muted-foreground/30",
};

/** Who acts next, in the reader's terms. */
const NEXT_ACTOR_LABELS: Record<FirstmateTask["nextActor"], string> = {
  user: "You",
  worker: "Worker",
  coordinator: "Firstmate",
  external: "Someone else",
};

const CLOSED_STATE_LABELS: Partial<Record<FirstmateTask["state"], string>> = {
  done: "Done",
  dropped: "Dropped",
};

export const EVENT_ACTOR_LABELS: Record<FirstmateTaskEvent["actor"], string> = {
  coordinator: "Firstmate",
  user: "You",
  system: "System",
};

export function relativeAge(value: string): string {
  return formatRelativeTimeLabel(value) || "just now";
}

/** What the card's meta line says about who has the ball, when the task has no next step. */
export function taskStatusLabel(task: FirstmateTask): string {
  if (firstmateTaskStatus(task) === "backlog") return "Parked";
  const closed = CLOSED_STATE_LABELS[task.state];
  if (closed) return closed;
  return `Next: ${NEXT_ACTOR_LABELS[task.nextActor]}`;
}

/** Who acts next, for the small chip beside a task's next step. */
export function nextActorLabel(task: FirstmateTask): string {
  return NEXT_ACTOR_LABELS[task.nextActor];
}

/**
 * What happens next on an open task, written by its coordinator. Null for a
 * closed task, or one from before next steps, which falls back to
 * `taskStatusLabel`.
 */
export function taskNextStep(task: FirstmateTask): string | null {
  if (CLOSED_STATE_LABELS[task.state]) return null;
  const step = task.nextStep?.trim();
  return step ? step : null;
}

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * A task's done-when text as separate criteria, so the detail can show them
 * as a list. Bullet or numbered lines are used as written; otherwise a prose
 * paragraph splits at sentence ends. Text with one sentence stays whole.
 */
export function doneCriteria(text: string): ReadonlyArray<string> {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.some((line) => LIST_MARKER.test(line))) {
    return lines.map((line) => line.replace(LIST_MARKER, ""));
  }
  return lines
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * History worth reading in the detail, newest first. Next-step events are
 * left out: the current one is already shown above the history.
 */
export function readableTaskEvents(
  events: ReadonlyArray<FirstmateTaskEvent>,
): ReadonlyArray<FirstmateTaskEvent> {
  return events.filter((event) => !/^next step:/i.test(event.summary.trim())).toReversed();
}
