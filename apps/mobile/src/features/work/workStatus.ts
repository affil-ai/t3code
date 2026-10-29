/**
 * Colors and labels the Work screens use for task sections and worker
 * chats. The board's lifecycle rules live in client-runtime; this file only
 * decides how they look on mobile.
 */
import type { FirstmateColumnId } from "@t3tools/client-runtime/firstmate/board";

import type { ThreadListV2Status } from "../threads/threadListV2";

/** A small dot per section; it is the board's only color, as on web. */
export const COLUMN_DOT_CLASS: Record<FirstmateColumnId, string> = {
  standup: "bg-primary",
  backlog: "bg-foreground-muted/40",
  "needs-you": "bg-warning-foreground",
  ready: "bg-adaptive-emerald-600-400",
  monitoring: "bg-adaptive-emerald-600-400/50",
  planning: "bg-primary/60",
  "in-progress": "bg-adaptive-sky-600-400",
  "in-review": "bg-foreground-muted/60",
  hillclimb: "bg-adaptive-sky-600-400/50",
  done: "bg-foreground-muted/30",
};

export interface WorkerStatusPresentation {
  readonly label: string;
  readonly dotClassName: string;
}

/**
 * A worker chat's status dot, from the thread list's status. An idle chat
 * shows nothing unless it finished since it was last opened. Nothing pulses:
 * continuous animation costs GPU on every frame.
 */
export function workerStatusPresentation(
  status: ThreadListV2Status,
  hasUnseenCompletion: boolean,
): WorkerStatusPresentation | null {
  switch (status) {
    case "approval":
      return { label: "Pending approval", dotClassName: "bg-warning-foreground" };
    case "input":
      return { label: "Awaiting input", dotClassName: "bg-adaptive-indigo-600-300" };
    case "request":
      return { label: "Guest request", dotClassName: "bg-adaptive-fuchsia-600-300" };
    case "working":
      return { label: "Working", dotClassName: "bg-adaptive-sky-600-400" };
    case "waiting":
      return { label: "Waiting", dotClassName: "bg-foreground-muted" };
    case "failed":
      return { label: "Failed", dotClassName: "bg-danger-foreground" };
    case "limited":
      return { label: "Usage limited", dotClassName: "bg-warning-foreground" };
    case "ready":
      return hasUnseenCompletion
        ? { label: "Finished", dotClassName: "bg-adaptive-emerald-700-300" }
        : null;
  }
}
