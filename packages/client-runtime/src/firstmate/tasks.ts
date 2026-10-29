/**
 * How the Tasks board's sections, states, actors, and history read, shared by
 * the web panel and the mobile Work screens. Styling stays in each client.
 *
 * @module firstmate/tasks
 */
import {
  FIRSTMATE_NEXT_ACTOR_LABELS,
  type FirstmateTask,
  type FirstmateTaskEvent,
} from "@t3tools/contracts";

import type { FirstmateColumnId } from "./board.ts";

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

export {
  FIRSTMATE_NEXT_ACTOR_LABELS as NEXT_ACTOR_LABELS,
  firstmateTaskClosed as isTaskClosed,
  firstmateTaskNextStep as taskNextStep,
  firstmateTaskStatusLabel as taskStatusLabel,
} from "@t3tools/contracts";

export const EVENT_ACTOR_LABELS: Record<FirstmateTaskEvent["actor"], string> = {
  coordinator: "Firstmate",
  user: "You",
  system: "System",
};

/** Who acts next, for the small chip beside a task's next step. */
export function nextActorLabel(task: FirstmateTask): string {
  return FIRSTMATE_NEXT_ACTOR_LABELS[task.nextActor];
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
  // No lookbehind: break after sentence punctuation that precedes a capital.
  return lines
    .flatMap((line) => line.replace(/([.!?])\s+(?=[A-Z])/g, "$1\n").split("\n"))
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
  const kept = events.filter((event) => !/^next step:/i.test(event.summary.trim()));
  // `filter` already copied the array, and Hermes lacks `toReversed`.
  // oxlint-disable-next-line unicorn/no-array-reverse
  return kept.reverse();
}

/** The message that approves the coordinator's next step, as the user would type it. */
export function approvalMessage(nextStep: string): string {
  return `Approved: ${nextStep}`;
}

/**
 * A merged pull request's link label without its trailing state, so
 * "PR #12 (open)" reads "PR #12" once the live state says merged.
 */
export function mergedPullRequestLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "");
}
