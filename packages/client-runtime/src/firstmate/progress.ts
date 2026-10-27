/**
 * How a task's progress reads on the board: one line of text, plus the values
 * for a metric's sparkline or a count's bar.
 *
 * @module firstmate/progress
 */
import { firstmateTaskStatus, type FirstmateTask } from "@t3tools/contracts";

export type FirstmateProgressView =
  /** A hillclimb whose worker has not measured its baseline yet. */
  | { readonly kind: "pending"; readonly text: string }
  | { readonly kind: "metric"; readonly text: string; readonly values: readonly number[] }
  /** `fraction` is done out of the total, 0 to 1; null without a total. */
  | { readonly kind: "count"; readonly text: string; readonly fraction: number | null };

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** "87.5%", "$12.40", "1,611 hotels": a percent sign hugs the number, a dollar sign leads it. */
function withUnit(value: number, unit: string | undefined): string {
  const number = numberFormat.format(value);
  const trimmed = unit?.trim() ?? "";
  if (trimmed === "") return number;
  if (trimmed === "%") return `${number}%`;
  if (trimmed === "$") return `$${number}`;
  return `${number} ${trimmed}`;
}

/** The task's progress line, or null when it has none to show. */
export function firstmateProgressView(task: FirstmateTask): FirstmateProgressView | null {
  const progress = task.progress ?? null;
  if (progress === null) {
    return firstmateTaskStatus(task) === "hillclimb"
      ? { kind: "pending", text: "baseline pending" }
      : null;
  }
  const { label, unit, value, baseline, target } = progress;
  if (progress.kind === "count") {
    if (target === undefined) {
      return { kind: "count", text: `${label} ${withUnit(value, unit)}`, fraction: null };
    }
    const amount = `${numberFormat.format(value)} / ${withUnit(target, unit)}`;
    return {
      kind: "count",
      // A unit names what is counted; without one, the label does.
      text: unit?.trim() ? amount : `${label} ${amount}`,
      fraction: target > 0 ? Math.min(Math.max(value / target, 0), 1) : null,
    };
  }
  const parts = [`${label} ${withUnit(value, unit)}`];
  if (baseline !== undefined) parts.push(`baseline ${withUnit(baseline, unit)}`);
  if (target !== undefined) parts.push(`target ${withUnit(target, unit)}`);
  return {
    kind: "metric",
    text: parts.join(" · "),
    values: progress.history.map((point) => point.value),
  };
}

/**
 * SVG polyline points drawing `values` left to right inside a `width` by
 * `height` box, higher values nearer the top. Empty below two values, where a
 * line says nothing.
 */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const step = width / (values.length - 1);
  return values
    .map((value, index) => {
      // A flat history draws a level line through the middle.
      const y = span === 0 ? height / 2 : height - ((value - min) / span) * height;
      return `${round(index * step)},${round(y)}`;
    })
    .join(" ");
}

const round = (value: number) => Math.round(value * 10) / 10;
