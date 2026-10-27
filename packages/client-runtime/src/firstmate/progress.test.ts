import type { FirstmateTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { firstmateProgressView, sparklinePoints } from "./progress.ts";

const AT = "2026-10-24T10:00:00.000Z";

function task(
  status: FirstmateTask["status"],
  progress:
    | (Omit<NonNullable<FirstmateTask["progress"]>, "updatedAt" | "history"> & {
        readonly history?: readonly number[];
      })
    | null = null,
): FirstmateTask {
  return {
    status,
    state: "open",
    nextActor: "worker",
    progress:
      progress === null
        ? null
        : {
            ...progress,
            updatedAt: AT,
            history: (progress.history ?? [progress.value]).map((value) => ({ value, at: AT })),
          },
  } as unknown as FirstmateTask;
}

describe("firstmateProgressView", () => {
  it("reads a metric with its baseline and target, and its history for the sparkline", () => {
    expect(
      firstmateProgressView(
        task("hillclimb", {
          label: "Recall",
          kind: "metric",
          value: 87.5,
          baseline: 72,
          target: 90,
          unit: "%",
          history: [72, 80, 87.5],
        }),
      ),
    ).toEqual({
      kind: "metric",
      text: "Recall 87.5% · baseline 72% · target 90%",
      values: [72, 80, 87.5],
    });
  });

  it("reads a count against its total with the unit, or the label without one", () => {
    expect(
      firstmateProgressView(
        task("in_progress", {
          label: "Hotels",
          kind: "count",
          value: 1611,
          target: 1942,
          unit: "hotels",
        }),
      ),
    ).toMatchObject({ kind: "count", text: "1,611 / 1,942 hotels" });
    expect(
      firstmateProgressView(
        task("in_progress", { label: "Pages", kind: "count", value: 3, target: 4 }),
      ),
    ).toEqual({ kind: "count", text: "Pages 3 / 4", fraction: 0.75 });
    expect(
      firstmateProgressView(
        task("in_progress", { label: "Rows", kind: "count", value: 12, unit: "rows" }),
      ),
    ).toEqual({ kind: "count", text: "Rows 12 rows", fraction: null });
    expect(
      firstmateProgressView(
        task("in_progress", { label: "Over", kind: "count", value: 12, target: 10 }),
      ),
    ).toMatchObject({ fraction: 1 });
  });

  it("puts a dollar sign before the number", () => {
    expect(
      firstmateProgressView(
        task("hillclimb", {
          label: "Cost",
          kind: "metric",
          value: 12.4,
          unit: "$",
          direction: "lower",
        }),
      ),
    ).toMatchObject({ text: "Cost $12.4" });
  });

  it("shows baseline pending only for a hillclimb with no progress yet", () => {
    expect(firstmateProgressView(task("hillclimb"))).toEqual({
      kind: "pending",
      text: "baseline pending",
    });
    expect(firstmateProgressView(task("in_progress"))).toBeNull();
  });
});

describe("sparklinePoints", () => {
  it("spans the width with higher values nearer the top", () => {
    expect(sparklinePoints([0, 5, 10], 40, 10)).toBe("0,10 20,5 40,0");
  });

  it("draws a flat history as a level line and nothing for one value", () => {
    expect(sparklinePoints([3, 3], 40, 10)).toBe("0,5 40,5");
    expect(sparklinePoints([3], 40, 10)).toBe("");
  });
});
