/**
 * How a progress report lands on a task's stored progress.
 *
 * @module progress
 */
import {
  FIRSTMATE_PROGRESS_HISTORY_LIMIT,
  type FirstmateTaskProgress,
  type FirstmateTaskProgressReport,
} from "@t3tools/contracts";

/**
 * The progress after `report` arrives at `at`. History gains a point only when
 * the value moves, keeps the newest `FIRSTMATE_PROGRESS_HISTORY_LIMIT` points,
 * and starts over when the report measures something else (another label,
 * kind, or unit), so a sparkline never mixes two scales.
 */
export function applyProgressReport(
  previous: FirstmateTaskProgress | null,
  report: FirstmateTaskProgressReport,
  at: string,
): FirstmateTaskProgress {
  const sameMeasure =
    previous !== null &&
    previous.label === report.label &&
    previous.kind === report.kind &&
    (previous.unit ?? "") === (report.unit ?? "");
  const history = sameMeasure ? previous.history : [];
  const moved = history.at(-1)?.value !== report.value;
  return {
    ...report,
    updatedAt: at,
    history: moved
      ? [...history, { value: report.value, at }].slice(-FIRSTMATE_PROGRESS_HISTORY_LIMIT)
      : history,
  };
}
