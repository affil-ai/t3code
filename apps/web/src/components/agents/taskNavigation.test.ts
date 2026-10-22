import { describe, expect, it } from "vite-plus/test";
import { FirstmateTaskId, ThreadId, type FirstmateTask } from "@t3tools/contracts";

import { FIRSTMATE_SECTION_ORDER } from "../firstmate/firstmateBoard.logic";
import { adjacentSidebarTask, OPEN_TASK_COLUMNS, sidebarNavigationTasks } from "./taskNavigation";

const task = (id: string, nextActor: "user" | "worker" = "worker"): FirstmateTask => ({
  id: FirstmateTaskId.make(id),
  title: id,
  status: "in_progress",
  state: "open",
  nextActor,
  intent: id,
  nextStep: null,
  workerThreadId: ThreadId.make(`${id}-thread`),
  note: "",
  wakeAt: null,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
  closedAt: null,
  definitionOfDone: id,
  links: [],
  artifacts: [],
  closeEvidence: null,
});

describe("task sidebar navigation", () => {
  it("keeps attention tasks only in their lifecycle section and navigation order", () => {
    const first = task("first", "user");
    const second = task("second");
    expect(OPEN_TASK_COLUMNS).not.toContain("needs-you");
    expect(sidebarNavigationTasks([first, second])).toEqual([first, second]);
    const review = { ...task("review", "user"), status: "in_review" as const };
    expect(sidebarNavigationTasks([review, second])).toEqual([second, review]);
  });

  it("uses the Tasks panel's section order without Done", () => {
    expect(OPEN_TASK_COLUMNS).toEqual(FIRSTMATE_SECTION_ORDER.filter((c) => c !== "done"));
    const monitoring = { ...task("monitoring"), status: "monitoring" as const };
    const ready = { ...task("ready"), status: "ready_for_deployment" as const };
    const work = task("work");
    expect(sidebarNavigationTasks([work, ready, monitoring])).toEqual([monitoring, ready, work]);
  });

  it("wraps at both ends", () => {
    const tasks = sidebarNavigationTasks([task("first"), task("second")]);
    expect(adjacentSidebarTask(tasks, "first", "previous")?.id).toBe("second");
    expect(adjacentSidebarTask(tasks, "second", "next")?.id).toBe("first");
  });
});
