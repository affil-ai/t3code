import type { FirstmateTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FIRSTMATE_COLUMN_IDS,
  countFirstmateNeedsYou,
  countFirstmateOpenTasks,
  firstmateColumnForTask,
  isPullRequestUrl,
  isSlackUrl,
  mapFirstmateBoard,
  type FirstmateColumnId,
} from "./firstmateBoard.logic";

const STATES = ["open", "waiting", "ready", "done", "dropped"] as const;
const ACTORS = ["coordinator", "worker", "user", "external"] as const;

function task(
  id: string,
  state: FirstmateTask["state"],
  nextActor: FirstmateTask["nextActor"],
  updatedAt = "2026-10-12T10:00:00.000Z",
  closedAt: string | null = null,
  workerThreadId: string | null = null,
): FirstmateTask {
  return {
    id,
    title: id,
    intent: `Intent for ${id}`,
    definitionOfDone: `Done for ${id}`,
    state,
    nextActor,
    note: "",
    wakeAt: null,
    workerThreadId,
    links: [],
    closeEvidence: null,
    createdAt: updatedAt,
    updatedAt,
    closedAt,
  } as unknown as FirstmateTask;
}

describe("firstmateColumnForTask", () => {
  // Every state and next-actor pair, with the column it must land in.
  const expected: Record<
    FirstmateTask["state"],
    Record<FirstmateTask["nextActor"], FirstmateColumnId>
  > = {
    open: {
      user: "needs-you",
      worker: "in-progress",
      coordinator: "planning",
      external: "in-review",
    },
    ready: { user: "ready", worker: "ready", coordinator: "planning", external: "ready" },
    waiting: {
      user: "needs-you",
      worker: "in-review",
      coordinator: "planning",
      external: "in-review",
    },
    done: { user: "done", worker: "done", coordinator: "done", external: "done" },
    dropped: { user: "done", worker: "done", coordinator: "done", external: "done" },
  };

  const cases = STATES.flatMap((state) =>
    ACTORS.map((actor) => [state, actor, expected[state][actor]] as const),
  );

  it.each(cases)("puts a %s task for %s in %s", (state, actor, column) => {
    expect(firstmateColumnForTask(task("t", state, actor))).toBe(column);
  });

  it("lets a closed task leave Needs you", () => {
    expect(firstmateColumnForTask(task("t", "done", "user"))).toBe("done");
  });

  it("keeps a decision for the user in Needs you while the task waits", () => {
    expect(firstmateColumnForTask(task("t", "waiting", "user"))).toBe("needs-you");
  });

  it("keeps a ready task out of Needs you even when the user acts next", () => {
    expect(firstmateColumnForTask(task("t", "ready", "user"))).toBe("ready");
  });

  it("moves a blocked worker out of In progress", () => {
    expect(firstmateColumnForTask(task("t", "waiting", "worker"))).toBe("in-review");
  });

  it("plans a task the coordinator acts on, with or without a worker", () => {
    expect(firstmateColumnForTask(task("t", "open", "coordinator"))).toBe("planning");
    expect(
      firstmateColumnForTask(task("t", "waiting", "coordinator", undefined, null, "worker")),
    ).toBe("planning");
  });

  it("does not plan a closed task", () => {
    expect(firstmateColumnForTask(task("t", "done", "coordinator"))).toBe("done");
    expect(firstmateColumnForTask(task("t", "dropped", "coordinator"))).toBe("done");
  });
});

describe("mapFirstmateBoard", () => {
  it("places every task in exactly one column", () => {
    const tasks = STATES.flatMap((state) =>
      ACTORS.map((actor) => task(`${state}-${actor}`, state, actor)),
    );
    const columns = mapFirstmateBoard(tasks);
    const placed = FIRSTMATE_COLUMN_IDS.flatMap((column) => columns[column].map((t) => t.id));
    expect(placed.toSorted()).toEqual(tasks.map((t) => t.id).toSorted());
  });

  it("sorts each column by newest activity", () => {
    const newer = task("newer", "open", "user", "2026-10-12T12:00:00.000Z");
    const older = task("older", "open", "user", "2026-10-12T11:00:00.000Z");
    expect(mapFirstmateBoard([older, newer])["needs-you"].map((t) => t.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("sorts ready tasks newest first", () => {
    const newer = task("ready-newer", "ready", "user", "2026-10-12T12:00:00.000Z");
    const older = task("ready-older", "ready", "worker", "2026-10-12T11:00:00.000Z");
    expect(mapFirstmateBoard([older, newer]).ready.map((t) => t.id)).toEqual([
      "ready-newer",
      "ready-older",
    ]);
  });

  it("orders closed tasks by close time and keeps the latest 20", () => {
    const done = Array.from({ length: 25 }, (_, index) =>
      task(
        `done-${String(index).padStart(2, "0")}`,
        index % 2 === 0 ? "done" : "dropped",
        "coordinator",
        // Update times run the other way, so the order must come from closedAt.
        new Date(Date.UTC(2026, 9, 1, index)).toISOString(),
        new Date(Date.UTC(2026, 9, 12, 23 - index)).toISOString(),
      ),
    );
    const columns = mapFirstmateBoard(done);
    expect(columns.done).toHaveLength(20);
    expect(columns.done[0]?.id).toBe("done-00");
    expect(columns.done.at(-1)?.id).toBe("done-19");
  });
});

describe("counts", () => {
  const tasks = [
    task("a", "open", "user"),
    task("b", "waiting", "user"),
    task("c", "open", "worker"),
    task("d", "done", "user"),
    task("e", "ready", "user"),
  ];

  it("counts what needs the user, leaving out ready tasks", () => {
    expect(countFirstmateNeedsYou(tasks)).toBe(2);
  });

  it("leaves planning tasks out of the Needs-you count", () => {
    expect(countFirstmateNeedsYou([task("q", "open", "coordinator")])).toBe(0);
  });

  it("counts tasks that are not closed", () => {
    expect(countFirstmateOpenTasks(tasks)).toBe(4);
  });
});

describe("isPullRequestUrl", () => {
  it("recognizes GitHub and GitLab change requests", () => {
    expect(isPullRequestUrl("https://github.com/acme/app/pull/42")).toBe(true);
    expect(isPullRequestUrl("https://gitlab.com/acme/app/-/merge_requests/7")).toBe(true);
    expect(isPullRequestUrl("https://example.com/report.html")).toBe(false);
  });
});

describe("isSlackUrl", () => {
  it("recognizes Slack workspace links only", () => {
    expect(isSlackUrl("https://affil.slack.com/archives/C123/p1700000000000100")).toBe(true);
    expect(isSlackUrl("https://app.slack.com/client/T1/C2")).toBe(true);
    expect(isSlackUrl("https://example.com/slack.com")).toBe(false);
    expect(isSlackUrl("not a url")).toBe(false);
  });
});
