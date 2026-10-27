/**
 * What the Tasks panel's list and task detail share on the web: the
 * coordinator thread the panel sits beside, each column's dot color, and how
 * ages read. Labels and next-step text live in
 * `@t3tools/client-runtime/firstmate/tasks`, shared with mobile.
 *
 * @module firstmateTasksShared
 */
import type { FirstmateColumnId } from "@t3tools/client-runtime/firstmate/board";
import type { ThreadId } from "@t3tools/contracts";
import { createContext } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";

/** The coordinator chat beside the panel; artifact images are signed against it. */
export const CoordinatorThreadContext = createContext<ThreadId | null>(null);

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

export function relativeAge(value: string): string {
  return formatRelativeTimeLabel(value) || "just now";
}
