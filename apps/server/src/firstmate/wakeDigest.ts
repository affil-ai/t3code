/**
 * The text and timeline row of a Firstmate wake. Pure: the reactor decides
 * when to wake and calls these to say what happened.
 *
 * @module wakeDigest
 */
import type { OrchestrationV2Notification } from "@t3tools/contracts";

export type FirstmateWakeReason =
  | "worker-completed"
  | "worker-failed"
  | "worker-interrupted"
  | "worker-waiting"
  | "wake-time"
  | "orphan";

export interface FirstmateWake {
  readonly taskId: string;
  readonly title: string;
  readonly reason: FirstmateWakeReason;
  readonly additionalReasons?: ReadonlyArray<FirstmateWakeReason>;
  readonly runId?: string;
}

export function wakeDigest(wakes: ReadonlyArray<FirstmateWake>): string {
  return [
    "Wake-up from your task board:",
    ...wakes.map(
      (wake) =>
        `- ${wake.taskId} ${wake.title}: ${[wake.reason, ...(wake.additionalReasons ?? [])].join(", ")}`,
    ),
    "",
    "Reconcile with firstmate_task_list, update every task you touch, and tell the user only about outcomes and decisions.",
  ].join("\n");
}

const WAKE_REASON_LABELS: Record<FirstmateWakeReason, string> = {
  "worker-completed": "worker finished",
  "worker-failed": "worker failed",
  "worker-interrupted": "worker stopped",
  "worker-waiting": "worker needs input",
  "wake-time": "check-in time",
  orphan: "no worker running",
};

// Enough to tell the tasks apart in a one-line row; the full digest is the message text.
const SUMMARY_TASKS = 3;
const SUMMARY_TITLE_LENGTH = 40;

function shortTitle(title: string): string {
  return title.length <= SUMMARY_TITLE_LENGTH
    ? title
    : `${title.slice(0, SUMMARY_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * The compact timeline row for a wake. The coordinator still receives the
 * full digest as the message text; this is what the user sees.
 */
export function wakeNotification(wakes: ReadonlyArray<FirstmateWake>): OrchestrationV2Notification {
  const reasons = new Set(
    wakes.flatMap((wake) => [wake.reason, ...(wake.additionalReasons ?? [])]),
  );
  const outcome = reasons.has("worker-failed")
    ? "failed"
    : reasons.has("worker-waiting")
      ? "updated"
      : "completed";
  const items = wakes
    .slice(0, SUMMARY_TASKS)
    .map((wake) => `${shortTitle(wake.title)} (${WAKE_REASON_LABELS[wake.reason]})`);
  const more = wakes.length - items.length;
  const count = wakes.length === 1 ? "1 update" : `${wakes.length} updates`;
  return {
    source: { kind: "monitor" },
    outcome,
    summary: `Tasks: ${count} — ${items.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
    // Expanding the row shows the same digest the coordinator received.
    detail: wakeDigest(wakes),
  };
}

/**
 * Every wake message id starts with this, so a queued wake can be found. Each
 * agent's chat only ever holds its own wakes, so the prefix needs no agent.
 */
export const WAKE_MESSAGE_PREFIX = "firstmate:wake-message:";
const WAKE_REASONS: ReadonlySet<string> = new Set<FirstmateWakeReason>([
  "worker-completed",
  "worker-failed",
  "worker-interrupted",
  "worker-waiting",
  "wake-time",
  "orphan",
]);

/**
 * Reads the task lines back out of a digest written by `wakeDigest`, so a
 * queued wake can be folded into without the reactor remembering it, even
 * across a restart. Run ids are not in the digest.
 */
export function parseWakeDigest(text: string): ReadonlyArray<FirstmateWake> {
  return text.split("\n").flatMap((line) => {
    const match = /^- (\S+) (.+): ([a-z-]+(?:, [a-z-]+)*)$/.exec(line);
    if (match === null) return [];
    const reasons = match[3]!.split(", ");
    if (!reasons.every((reason) => WAKE_REASONS.has(reason))) return [];
    const [reason, ...additionalReasons] = reasons as FirstmateWakeReason[];
    return [{ taskId: match[1]!, title: match[2]!, reason: reason!, additionalReasons }];
  });
}

/**
 * Folds `next` into `pending`: one line per task, reasons combined in the
 * order first seen, and the newest run id. Tasks keep their first position.
 */
export function mergeWakes(
  pending: ReadonlyArray<FirstmateWake>,
  next: ReadonlyArray<FirstmateWake>,
): ReadonlyArray<FirstmateWake> {
  const merged = new Map<string, FirstmateWake>();
  for (const wake of [...pending, ...next]) {
    const existing = merged.get(wake.taskId);
    if (existing === undefined) {
      merged.set(wake.taskId, wake);
      continue;
    }
    const reasons = [
      ...new Set([
        existing.reason,
        ...(existing.additionalReasons ?? []),
        wake.reason,
        ...(wake.additionalReasons ?? []),
      ]),
    ];
    merged.set(wake.taskId, {
      taskId: wake.taskId,
      title: wake.title,
      reason: reasons[0]!,
      additionalReasons: reasons.slice(1),
      ...((wake.runId ?? existing.runId) === undefined
        ? {}
        : { runId: wake.runId ?? existing.runId }),
    });
  }
  return [...merged.values()];
}
