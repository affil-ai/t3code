/**
 * A task's progress line, under its title on the board card and in the task
 * detail. It stays neutral: the column dot is the board's only color.
 */
import type { FirstmateTask } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { firstmateProgressView, sparklinePoints } from "./firstmateProgress";

const SPARK_WIDTH = 40;
const SPARK_HEIGHT = 10;

export function TaskProgressLine({
  task,
  className,
}: {
  readonly task: FirstmateTask;
  readonly className?: string;
}) {
  const view = firstmateProgressView(task);
  if (view === null) return null;
  const points =
    view.kind === "metric" ? sparklinePoints(view.values, SPARK_WIDTH, SPARK_HEIGHT) : "";
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground",
        className,
      )}
    >
      <span className={cn("truncate tabular-nums", view.kind === "pending" && "italic")}>
        {view.text}
      </span>
      {points !== "" ? (
        <svg
          aria-hidden
          className="shrink-0 overflow-visible text-muted-foreground/70"
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        >
          <polyline
            points={points}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.25}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}
      {view.kind === "count" && view.fraction !== null ? (
        <span aria-hidden className="h-0.5 w-12 shrink-0 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full bg-muted-foreground/60"
            style={{ width: `${view.fraction * 100}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}
