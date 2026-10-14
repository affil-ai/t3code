import type { FirstmateTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nextActorLabel, taskNextStep, taskStatusLabel } from "./firstmateTasksShared";

const task = (overrides: Partial<FirstmateTask>): FirstmateTask =>
  ({
    id: "firstmate-task:1",
    title: "Merge #4118",
    intent: "Merge it.",
    definitionOfDone: "Merged.",
    state: "ready",
    nextActor: "user",
    note: "",
    wakeAt: null,
    workerThreadId: null,
    links: [],
    closeEvidence: null,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  }) as FirstmateTask;

describe("taskNextStep", () => {
  it("shows the coordinator's phrase on an open task", () => {
    const withStep = task({ nextStep: "Approve merge of #4118" });
    expect(taskNextStep(withStep)).toBe("Approve merge of #4118");
    expect(nextActorLabel(withStep)).toBe("You");
  });

  it("falls back to who acts next when there is no phrase", () => {
    for (const nextStep of [undefined, null, "  "]) {
      const fallback = task({ nextStep });
      expect(taskNextStep(fallback)).toBeNull();
      expect(taskStatusLabel(fallback)).toBe("Next: You");
    }
  });

  it("hides the phrase once the task is closed", () => {
    const closed = task({ state: "done", nextStep: "Approve merge of #4118" });
    expect(taskNextStep(closed)).toBeNull();
    expect(taskStatusLabel(closed)).toBe("Done");
  });
});
