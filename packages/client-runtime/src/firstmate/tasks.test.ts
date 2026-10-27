import type { FirstmateTask, FirstmateTaskEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  approvalMessage,
  doneCriteria,
  mergedPullRequestLabel,
  nextActorLabel,
  readableTaskEvents,
  taskNextStep,
  taskStatusLabel,
} from "./tasks.ts";

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

describe("doneCriteria", () => {
  it("splits a prose paragraph at sentence ends", () => {
    expect(
      doneCriteria("One PR into dev. Expose 11 tools, e.g. analytics. Merge requires approval."),
    ).toEqual(["One PR into dev.", "Expose 11 tools, e.g. analytics.", "Merge requires approval."]);
  });

  it("keeps written bullet and numbered lines", () => {
    expect(doneCriteria("- Tests pass.\n* Deployed. Verified.\n2) Merged")).toEqual([
      "Tests pass.",
      "Deployed. Verified.",
      "Merged",
    ]);
  });

  it("leaves a single sentence whole", () => {
    expect(doneCriteria("Merged.")).toEqual(["Merged."]);
  });
});

describe("readableTaskEvents", () => {
  const event = (id: string, summary: string) => ({ id, summary }) as FirstmateTaskEvent;

  it("drops next-step events and puts the newest first", () => {
    const events = [event("1", "Created"), event("2", "Next step: Approve"), event("3", "Shipped")];
    expect(readableTaskEvents(events).map((e) => e.id)).toEqual(["3", "1"]);
  });
});

describe("approvalMessage", () => {
  it("approves the next step by name", () => {
    expect(approvalMessage("Merge #12")).toBe("Approved: Merge #12");
  });
});

describe("mergedPullRequestLabel", () => {
  it("drops a trailing state and keeps labels without one", () => {
    expect(mergedPullRequestLabel("PR #12 (open)")).toBe("PR #12");
    expect(mergedPullRequestLabel("PR #12")).toBe("PR #12");
  });
});
