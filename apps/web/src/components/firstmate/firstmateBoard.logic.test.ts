import type { FirstmateTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FIRSTMATE_COLUMN_IDS,
  FIRSTMATE_SECTION_ORDER,
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
  status: FirstmateTask["status"] = undefined,
): FirstmateTask {
  return {
    id,
    title: id,
    intent: `Intent for ${id}`,
    definitionOfDone: `Done for ${id}`,
    state,
    status,
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
  it.each([
    ["backlog", "backlog"],
    ["planning", "planning"],
    ["in_progress", "in-progress"],
    ["in_review", "in-review"],
    ["ready_for_deployment", "ready"],
    ["monitoring", "monitoring"],
    ["done", "done"],
    ["canceled", "done"],
  ] as const)("keeps %s in %s for every next actor", (status, column) => {
    for (const nextActor of ACTORS)
      expect(firstmateColumnForTask({ ...task("t", "open", nextActor), status })).toBe(column);
  });
  // Every state and next-actor pair, with the column it must land in.
  const expected: Record<
    FirstmateTask["state"],
    Record<FirstmateTask["nextActor"], FirstmateColumnId>
  > = {
    open: {
      user: "in-progress",
      worker: "in-progress",
      coordinator: "planning",
      external: "in-review",
    },
    ready: { user: "ready", worker: "ready", coordinator: "ready", external: "ready" },
    waiting: {
      user: "in-review",
      worker: "in-review",
      coordinator: "in-review",
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

  it("uses explicit status instead of inferring lifecycle from the next actor", () => {
    expect(
      firstmateColumnForTask(task("backlog", "open", "worker", undefined, null, null, "backlog")),
    ).toBe("backlog");
    expect(
      firstmateColumnForTask(task("review", "open", "user", undefined, null, null, "in_review")),
    ).toBe("in-review");
  });

  it("keeps lifecycle status separate from Needs you", () => {
    expect(firstmateColumnForTask(task("t", "waiting", "user"))).toBe("in-review");
    expect(mapFirstmateBoard([task("t", "waiting", "user")])["needs-you"]).toHaveLength(1);
  });

  it("keeps a ready task out of Needs you even when the user acts next", () => {
    expect(firstmateColumnForTask(task("t", "ready", "user"))).toBe("ready");
  });

  it("moves a blocked worker out of In progress", () => {
    expect(firstmateColumnForTask(task("t", "waiting", "worker"))).toBe("in-review");
  });

  it("maps legacy planning but preserves review work handed back to the coordinator", () => {
    expect(firstmateColumnForTask(task("t", "open", "coordinator"))).toBe("planning");
    expect(
      firstmateColumnForTask(task("t", "waiting", "coordinator", undefined, null, "worker")),
    ).toBe("in-review");
  });

  it("does not plan a closed task", () => {
    expect(firstmateColumnForTask(task("t", "done", "coordinator"))).toBe("done");
    expect(firstmateColumnForTask(task("t", "dropped", "coordinator"))).toBe("done");
  });
});

describe("mapFirstmateBoard", () => {
  it("shows attention alongside lifecycle without counting parked or closed tasks", () => {
    const review = { ...task("review", "waiting", "user"), status: "in_review" as const };
    const backlog = { ...task("backlog", "open", "user"), status: "backlog" as const };
    const done = { ...task("done", "done", "user"), status: "done" as const };
    const columns = mapFirstmateBoard([review, backlog, done]);
    expect(columns["needs-you"].map((t) => t.id)).toEqual(["review"]);
    expect(columns["in-review"].map((t) => t.id)).toEqual(["review"]);
    expect(columns.backlog.map((t) => t.id)).toEqual(["backlog"]);
    expect(countFirstmateOpenTasks([review, backlog, done])).toBe(2);
  });
  it("groups monitoring tasks as open work outside Needs you unless the user acts next", () => {
    const watch = { ...task("watch", "open", "worker"), status: "monitoring" as const };
    const ask = { ...task("ask", "open", "user"), status: "monitoring" as const };
    const columns = mapFirstmateBoard([watch, ask]);
    expect(columns.monitoring.map((t) => t.id).toSorted()).toEqual(["ask", "watch"]);
    expect(columns["needs-you"].map((t) => t.id)).toEqual(["ask"]);
    expect(columns.ready).toHaveLength(0);
    expect(countFirstmateOpenTasks([watch, ask])).toBe(2);
  });

  it("places every task in exactly one column", () => {
    const tasks = STATES.flatMap((state) =>
      ACTORS.map((actor) => task(`${state}-${actor}`, state, actor)),
    );
    const columns = mapFirstmateBoard(tasks);
    const placed = FIRSTMATE_COLUMN_IDS.filter((column) => column !== "needs-you").flatMap(
      (column) => columns[column].map((t) => t.id),
    );
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

  it("counts attention across lifecycle sections, including deployment decisions", () => {
    expect(countFirstmateNeedsYou(tasks)).toBe(3);
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

describe("FIRSTMATE_SECTION_ORDER", () => {
  it("lists every lifecycle column once, in Vivek's order", () => {
    expect(FIRSTMATE_SECTION_ORDER).toEqual([
      "monitoring",
      "ready",
      "planning",
      "in-progress",
      "in-review",
      "backlog",
      "done",
    ]);
    expect(FIRSTMATE_SECTION_ORDER.toSorted()).toEqual(
      FIRSTMATE_COLUMN_IDS.filter((column) => column !== "needs-you").toSorted(),
    );
  });
});
