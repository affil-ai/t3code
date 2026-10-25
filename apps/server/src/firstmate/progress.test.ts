import { FIRSTMATE_PROGRESS_HISTORY_LIMIT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyProgressReport } from "./progress.ts";

const recall = (value: number) => ({ label: "Recall", kind: "metric", value, unit: "%" }) as const;
const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, "0")}:00.000Z`;

describe("applyProgressReport", () => {
  it("starts a history with the first report and stamps the report time", () => {
    expect(applyProgressReport(null, { ...recall(72), baseline: 72 }, at(0))).toEqual({
      ...recall(72),
      baseline: 72,
      updatedAt: at(0),
      history: [{ value: 72, at: at(0) }],
    });
  });

  it("adds a point only when the value moves", () => {
    const first = applyProgressReport(null, recall(72), at(0));
    const same = applyProgressReport(first, { ...recall(72), target: 90 }, at(1));
    expect(same.history).toEqual([{ value: 72, at: at(0) }]);
    expect(same).toMatchObject({ target: 90, updatedAt: at(1) });
    const moved = applyProgressReport(same, recall(80), at(2));
    expect(moved.history.map((point) => point.value)).toEqual([72, 80]);
  });

  it("keeps only the newest points once the cap is reached", () => {
    let progress = applyProgressReport(null, recall(0), at(0));
    for (let value = 1; value < FIRSTMATE_PROGRESS_HISTORY_LIMIT + 10; value += 1) {
      progress = applyProgressReport(progress, recall(value), at(value % 60));
    }
    expect(progress.history).toHaveLength(FIRSTMATE_PROGRESS_HISTORY_LIMIT);
    expect(progress.history.at(0)!.value).toBe(10);
    expect(progress.history.at(-1)!.value).toBe(FIRSTMATE_PROGRESS_HISTORY_LIMIT + 9);
  });

  it("starts the history over when the report measures something else", () => {
    const climbing = applyProgressReport(
      applyProgressReport(null, recall(72), at(0)),
      recall(80),
      at(1),
    );
    const precision = applyProgressReport(climbing, { ...recall(60), label: "Precision" }, at(2));
    expect(precision.history).toEqual([{ value: 60, at: at(2) }]);
    const count = applyProgressReport(
      climbing,
      { label: "Recall", kind: "count", value: 80, unit: "%" },
      at(3),
    );
    expect(count.history).toEqual([{ value: 80, at: at(3) }]);
    const unit = applyProgressReport(climbing, { ...recall(80), unit: "pts" }, at(4));
    expect(unit.history).toEqual([{ value: 80, at: at(4) }]);
  });
});
