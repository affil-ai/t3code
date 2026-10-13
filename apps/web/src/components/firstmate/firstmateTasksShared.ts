/**
 * What the Tasks panel's list and task detail share: the coordinator thread
 * the panel sits beside, and how columns, states, and actors read.
 *
 * @module firstmateTasksShared
 */
import type { FirstmateTask, FirstmateTaskEvent, ThreadId } from "@t3tools/contracts";
import { createContext } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import type { FirstmateColumnId } from "./firstmateBoard.logic";

/** The coordinator chat beside the panel; artifact images are signed against it. */
export const CoordinatorThreadContext = createContext<ThreadId | null>(null);

export const COLUMN_LABELS: Record<FirstmateColumnId, string> = {
  "needs-you": "Needs you",
  ready: "Ready for deployment",
  "in-progress": "In progress",
  "in-review": "In review",
  done: "Done",
};

export const COLUMN_EMPTY: Record<Exclude<FirstmateColumnId, "done">, string> = {
  "needs-you": "Nothing needs you",
  ready: "Nothing ready to deploy",
  "in-progress": "Nothing in progress",
  "in-review": "Nothing in review",
};

/** A small dot per column; it is the board's only color. */
export const COLUMN_DOT: Record<FirstmateColumnId, string> = {
  "needs-you": "bg-warning",
  ready: "bg-success",
  "in-progress": "bg-info",
  "in-review": "bg-muted-foreground/60",
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

/** What the card's meta line says about who has the ball. */
export function taskStatusLabel(task: FirstmateTask): string {
  const closed = CLOSED_STATE_LABELS[task.state];
  if (closed) return closed;
  return `Next: ${NEXT_ACTOR_LABELS[task.nextActor]}`;
}
