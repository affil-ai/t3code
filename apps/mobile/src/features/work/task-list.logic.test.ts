import type { FirstmateTask, ScheduledTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automationScheduleLabel,
  buildTaskListSections,
  coordinatorAutomations,
  taskRowPresentation,
} from "./task-list.logic";

function task(overrides: Partial<FirstmateTask> & Pick<FirstmateTask, "id">): FirstmateTask {
  return {
    title: `Task ${overrides.id}`,
    intent: "Do the thing",
    definitionOfDone: "It is done",
    state: "open",
    status: "in_progress",
    nextActor: "worker",
    note: "",
    wakeAt: null,
    workerThreadId: null,
    links: [],
    closeEvidence: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  } as FirstmateTask;
}

describe("buildTaskListSections", () => {
  const board = [
    task({ id: "a" as FirstmateTask["id"], status: "in_progress" }),
    task({ id: "b" as FirstmateTask["id"], status: "backlog" }),
    task({ id: "c" as FirstmateTask["id"], status: "monitoring" }),
    task({ id: "d" as FirstmateTask["id"], status: "done", state: "done" }),
  ];

  it("keeps the shared order and leaves out empty sections", () => {
    const sections = buildTaskListSections(board, { backlogOpen: false, doneOpen: false });
    expect(sections.map((section) => section.column)).toEqual([
      "monitoring",
      "in-progress",
      "backlog",
      "done",
    ]);
  });

  it("folds Backlog until it is opened, keeping its count", () => {
    const backlog = (backlogOpen: boolean) =>
      buildTaskListSections(board, { backlogOpen, doneOpen: false }).find(
        (section) => section.column === "backlog",
      )!;
    expect(backlog(false)).toMatchObject({ collapsible: true, open: false, count: 1 });
    expect(backlog(false).tasks).toEqual([]);
    expect(backlog(true).tasks.map((item) => item.id)).toEqual(["b"]);
  });

  it("folds Done separately, so closed tasks stay reachable", () => {
    const done = (doneOpen: boolean) =>
      buildTaskListSections(board, { backlogOpen: false, doneOpen }).at(-1)!;
    expect(done(false)).toMatchObject({ column: "done", collapsible: true, open: false, count: 1 });
    expect(done(true).tasks.map((item) => item.id)).toEqual(["d"]);
  });
});

describe("taskRowPresentation", () => {
  it("leads with the coordinator's next step and flags tasks waiting on the user", () => {
    const row = taskRowPresentation(
      task({
        id: "a" as FirstmateTask["id"],
        nextActor: "user",
        nextStep: "Approve the deploy",
        priority: true,
      }),
    );
    expect(row).toMatchObject({ needsYou: true, priority: true, detail: "Approve the deploy" });
  });

  it("falls back to who acts next without a next step", () => {
    expect(taskRowPresentation(task({ id: "a" as FirstmateTask["id"] })).detail).toBe(
      "Next: Worker",
    );
  });

  it("keeps a metric's reading and a count's fraction", () => {
    const metric = taskRowPresentation(
      task({
        id: "a" as FirstmateTask["id"],
        status: "hillclimb",
        progress: {
          label: "pass rate",
          kind: "metric",
          value: 82,
          baseline: 70,
          unit: "%",
          updatedAt: "2026-10-01T00:00:00.000Z",
          history: [],
        },
      }),
    );
    expect(metric.progress).toBe("pass rate 82%");
    const count = taskRowPresentation(
      task({
        id: "b" as FirstmateTask["id"],
        progress: {
          label: "hotels",
          kind: "count",
          value: 25,
          target: 100,
          updatedAt: "2026-10-01T00:00:00.000Z",
          history: [],
        },
      }),
    );
    expect(count).toMatchObject({ progress: "hotels 25 / 100", progressFraction: 0.25 });
  });
});

describe("automations", () => {
  const scheduled = (id: string, title: string, threadId: string | null) =>
    ({ id, title, threadId }) as unknown as ScheduledTask;

  it("lists only the automations bound to the coordinator chat, by title", () => {
    const tasks = [
      scheduled("1", "Weekly digest", "coordinator"),
      scheduled("2", "Other", "elsewhere"),
      scheduled("3", "Morning check", "coordinator"),
      scheduled("4", "Unbound", null),
    ];
    expect(
      coordinatorAutomations(tasks, "coordinator" as ScheduledTask["threadId"] & string).map(
        (task) => task.id,
      ),
    ).toEqual(["3", "1"]);
  });

  it("describes each kind of schedule", () => {
    expect(automationScheduleLabel({ type: "webhook" } as ScheduledTask["schedule"])).toBe(
      "On webhook",
    );
    expect(automationScheduleLabel({ type: "interval", everyMs: 15 * 60_000 })).toBe(
      "Every 15 minutes",
    );
    expect(
      automationScheduleLabel({
        type: "fixed_time",
        timeOfDay: "09:00",
        weekdays: [5, 1, 2, 3, 4],
      }),
    ).toBe("Weekdays at 09:00");
    expect(automationScheduleLabel({ type: "fixed_time", timeOfDay: "18:30" })).toBe(
      "Daily at 18:30",
    );
    expect(
      automationScheduleLabel({ type: "fixed_time", timeOfDay: "07:00", weekdays: [6, 0] }),
    ).toBe("Sun, Sat at 07:00");
  });
});
