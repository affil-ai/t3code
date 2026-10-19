import { describe, expect, it } from "vite-plus/test";

import { adjacentSidebarTask, sidebarNavigationTasks } from "./taskNavigation";

const task = (id: string, nextActor: "user" | "worker" = "worker") => ({
  id,
  title: id,
  status: "in_progress",
  state: "open",
  nextActor,
  intent: id,
  nextStep: null,
  workerThreadId: `${id}-thread`,
  updatedAt: "2026-10-19T00:00:00Z",
  closedAt: null,
  definitionOfDone: id,
  links: [],
  artifacts: [],
  closeEvidence: null,
});

describe("task sidebar navigation", () => {
  it("deduplicates tasks that appear in Needs you and their lifecycle section", () => {
    const first = task("first", "user");
    const second = task("second");
    expect(sidebarNavigationTasks([first, second])).toEqual([first, second]);
  });

  it("wraps at both ends", () => {
    const tasks = sidebarNavigationTasks([task("first"), task("second")]);
    expect(adjacentSidebarTask(tasks, "first", "previous")?.id).toBe("second");
    expect(adjacentSidebarTask(tasks, "second", "next")?.id).toBe("first");
  });
});
