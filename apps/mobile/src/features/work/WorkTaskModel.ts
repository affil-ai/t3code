/**
 * Pure rules for the Work task detail: finding a task on its agent's board,
 * what its next-step card says, how its progress draws, which quick actions
 * it offers, and the messages those actions send to the agent's coordinator
 * chat. Clients cannot write a task's status; the coordinator owns the board,
 * so every state change from the phone is a request in its chat.
 */
import { firstmateTaskStatus } from "@t3tools/contracts";
import type { AgentProfile, FirstmateSnapshot, FirstmateTask, ThreadId } from "@t3tools/contracts";
import { isPullRequestUrl, isSlackUrl } from "@t3tools/client-runtime/firstmate/board";
import type { FirstmateProgressView } from "@t3tools/client-runtime/firstmate/progress";
import { sparklinePoints } from "@t3tools/client-runtime/firstmate/progress";
import {
  approvalMessage,
  isTaskClosed,
  NEXT_ACTOR_LABELS,
  taskNextStep,
} from "@t3tools/client-runtime/firstmate/tasks";

/** One agent's board as the lookup sees it. `agent` is null on servers without agents. */
export interface WorkTaskBoard {
  readonly agent: AgentProfile | null;
  /** The latest board, which may be refreshing; null until the first one arrives. */
  readonly snapshot: FirstmateSnapshot | null;
  /** True while the board has not answered yet. */
  readonly loading: boolean;
}

export type WorkTaskLookup =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | {
      readonly kind: "found";
      readonly task: FirstmateTask;
      /** Null on servers that predate agents, where every task is Firstmate's. */
      readonly agent: AgentProfile | null;
      /** What the board calls its coordinator, e.g. "Firstmate". */
      readonly agentName: string;
      readonly coordinatorThreadId: ThreadId | null;
    };

/**
 * The task on the first board that has it. Boards are read lazily, so a
 * caller can stop opening streams once the task turns up. Missing only once
 * every board has answered without it.
 */
export function resolveWorkTaskLookup(
  taskId: string,
  boards: Iterable<WorkTaskBoard>,
): WorkTaskLookup {
  let loading = false;
  for (const board of boards) {
    const task = board.snapshot?.tasks.find((candidate) => candidate.id === taskId);
    if (task !== undefined && board.snapshot !== null) {
      return {
        kind: "found",
        task,
        agent: board.agent,
        agentName: board.agent?.name ?? board.snapshot.name,
        coordinatorThreadId: board.agent?.coordinatorThreadId ?? board.snapshot.coordinatorThreadId,
      };
    }
    if (board.loading) loading = true;
  }
  return loading ? { kind: "loading" } : { kind: "missing" };
}

/** Puts the hinted agent first, so its board is the one opened when it has the task. */
export function orderAgentsForLookup(
  agents: ReadonlyArray<AgentProfile>,
  agentIdHint: string | undefined,
): ReadonlyArray<AgentProfile> {
  if (agentIdHint === undefined) return agents;
  const hinted = agents.find((agent) => agent.id === agentIdHint);
  return hinted === undefined ? agents : [hinted, ...agents.filter((agent) => agent !== hinted)];
}

export interface WorkTaskNextStep {
  /** True when the next move is the user's; the card stands out. */
  readonly onUser: boolean;
  readonly eyebrow: string;
  readonly text: string;
}

/** Who acts next, naming the board's coordinator instead of "Firstmate" on custom agents. */
export function workTaskActorLabel(task: FirstmateTask, agentName: string): string {
  return task.nextActor === "coordinator" ? agentName : NEXT_ACTOR_LABELS[task.nextActor];
}

/** The next-step card, as web leads its task detail with. Null when the task has no next step. */
export function workTaskNextStep(task: FirstmateTask, agentName: string): WorkTaskNextStep | null {
  const text = taskNextStep(task);
  if (text === null) return null;
  const onUser = task.nextActor === "user";
  return {
    onUser,
    eyebrow: onUser ? "Your move" : `Waiting on ${workTaskActorLabel(task, agentName)}`,
    text,
  };
}

export const WORK_TASK_SPARK_WIDTH = 56;
export const WORK_TASK_SPARK_HEIGHT = 14;

export interface WorkTaskProgressDisplay {
  readonly text: string;
  /** A hillclimb whose baseline is not measured yet reads as provisional. */
  readonly provisional: boolean;
  /** Polyline points for a metric's history; null below two values. */
  readonly sparkline: string | null;
  /** Done out of the total, 0 to 1, for a count's bar; null without a total. */
  readonly fraction: number | null;
}

/** How a progress view draws on mobile: a sparkline for a metric, a bar for a count. */
export function workTaskProgressDisplay(
  view: FirstmateProgressView | null,
): WorkTaskProgressDisplay | null {
  if (view === null) return null;
  switch (view.kind) {
    case "pending":
      return { text: view.text, provisional: true, sparkline: null, fraction: null };
    case "metric": {
      const points = sparklinePoints(view.values, WORK_TASK_SPARK_WIDTH, WORK_TASK_SPARK_HEIGHT);
      return {
        text: view.text,
        provisional: false,
        sparkline: points === "" ? null : points,
        fraction: null,
      };
    }
    case "count":
      return { text: view.text, provisional: false, sparkline: null, fraction: view.fraction };
  }
}

export type WorkTaskLinkKind = "pull-request" | "slack" | "link";

export function workTaskLinkKind(url: string): WorkTaskLinkKind {
  if (isPullRequestUrl(url)) return "pull-request";
  if (isSlackUrl(url)) return "slack";
  return "link";
}

/** A request the phone can send to the coordinator about a task. */
export type WorkTaskAction = "approve" | "done" | "backlog" | "cancel" | "reopen";

export const WORK_TASK_ACTION_LABELS: Record<WorkTaskAction, string> = {
  approve: "Approve",
  done: "Mark done",
  backlog: "Move to backlog",
  cancel: "Cancel task",
  reopen: "Reopen",
};

/**
 * Which requests make sense for the task as it stands. Approval only when
 * the next move is the user's; a closed task can only be reopened.
 */
export function workTaskActions(task: FirstmateTask): ReadonlyArray<WorkTaskAction> {
  const status = firstmateTaskStatus(task);
  if (isTaskClosed(task) || status === "done" || status === "canceled") return ["reopen"];
  const actions: WorkTaskAction[] = [];
  if (task.nextActor === "user") actions.push("approve");
  actions.push("done");
  if (status !== "backlog") actions.push("backlog");
  actions.push("cancel");
  return actions;
}

/** What each request asks the coordinator to do. */
export function workTaskActionInstruction(task: FirstmateTask, action: WorkTaskAction): string {
  switch (action) {
    case "approve": {
      const step = taskNextStep(task);
      return step === null ? "Approved. Go ahead." : approvalMessage(step);
    }
    case "done":
      return "Please mark it done, with the evidence that it is complete.";
    case "backlog":
      return "Please move it to the backlog for now.";
    case "cancel":
      return "Please cancel it and close it as dropped.";
    case "reopen":
      return "Please reopen it.";
  }
}

/**
 * The chat message about a task. It names the task by title and id, so the
 * coordinator can tell which one is meant among many.
 */
export function buildWorkTaskMessage(
  task: Pick<FirstmateTask, "id" | "title">,
  body: string,
): string {
  return `About task "${task.title}" (${task.id}): ${body.trim()}`;
}
