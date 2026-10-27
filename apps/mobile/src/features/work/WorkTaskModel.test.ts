import type { AgentProfile, FirstmateSnapshot, FirstmateTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkTaskMessage,
  orderAgentsForLookup,
  resolveWorkTaskLookup,
  workTaskActionInstruction,
  workTaskActions,
  workTaskLinkKind,
  workTaskNextStep,
  workTaskProgressDisplay,
  type WorkTaskBoard,
} from "./WorkTaskModel";

function task(fields: Partial<FirstmateTask> = {}): FirstmateTask {
  return {
    id: "task-1",
    title: "Ship the Work tab",
    state: "open",
    status: "in_progress",
    nextActor: "worker",
    nextStep: null,
    ...fields,
  } as unknown as FirstmateTask;
}

function agent(id: string, name: string, coordinatorThreadId: string | null): AgentProfile {
  return { id, name, coordinatorThreadId } as unknown as AgentProfile;
}

function snapshot(tasks: ReadonlyArray<FirstmateTask>, name = "Firstmate"): FirstmateSnapshot {
  return { name, coordinatorThreadId: "fm-thread", tasks } as unknown as FirstmateSnapshot;
}

describe("resolveWorkTaskLookup", () => {
  it("finds the task on its agent's board with that agent's coordinator chat", () => {
    const scout = agent("scout", "Scout", "scout-thread");
    const lookup = resolveWorkTaskLookup("task-1", [
      {
        agent: agent("firstmate", "Firstmate", "fm-thread"),
        snapshot: snapshot([]),
        loading: false,
      },
      { agent: scout, snapshot: snapshot([task()]), loading: false },
    ]);
    expect(lookup).toMatchObject({
      kind: "found",
      agent: scout,
      agentName: "Scout",
      coordinatorThreadId: "scout-thread",
    });
  });

  it("stops reading boards once the task turns up", () => {
    const read: string[] = [];
    function* boards(): Generator<WorkTaskBoard> {
      read.push("first");
      yield { agent: null, snapshot: snapshot([task()]), loading: false };
      read.push("second");
      yield { agent: null, snapshot: null, loading: true };
    }
    expect(resolveWorkTaskLookup("task-1", boards()).kind).toBe("found");
    expect(read).toEqual(["first"]);
  });

  it("falls back to the board's own name and chat on servers without agents", () => {
    expect(
      resolveWorkTaskLookup("task-1", [
        { agent: null, snapshot: snapshot([task()], "Mate"), loading: false },
      ]),
    ).toMatchObject({ kind: "found", agentName: "Mate", coordinatorThreadId: "fm-thread" });
  });

  it("waits while a board is loading, and reports missing once all have answered", () => {
    expect(
      resolveWorkTaskLookup("task-1", [
        { agent: null, snapshot: snapshot([]), loading: false },
        { agent: null, snapshot: null, loading: true },
      ]),
    ).toEqual({ kind: "loading" });
    expect(
      resolveWorkTaskLookup("task-1", [{ agent: null, snapshot: snapshot([]), loading: false }]),
    ).toEqual({ kind: "missing" });
  });

  it("opens the hinted agent's board first", () => {
    const agents = [agent("firstmate", "Firstmate", null), agent("scout", "Scout", null)];
    expect(orderAgentsForLookup(agents, "scout").map((entry) => entry.id)).toEqual([
      "scout",
      "firstmate",
    ]);
    expect(orderAgentsForLookup(agents, "gone")).toBe(agents);
  });
});

describe("workTaskNextStep", () => {
  it("leads with the user's move", () => {
    expect(workTaskNextStep(task({ nextActor: "user", nextStep: "Approve #12" }), "Scout")).toEqual(
      { onUser: true, eyebrow: "Your move", text: "Approve #12" },
    );
  });

  it("names the agent when waiting on the coordinator", () => {
    expect(
      workTaskNextStep(task({ nextActor: "coordinator", nextStep: "Plan it" }), "Scout")?.eyebrow,
    ).toBe("Waiting on Scout");
    expect(
      workTaskNextStep(task({ nextActor: "worker", nextStep: "Fix tests" }), "Scout")?.eyebrow,
    ).toBe("Waiting on Worker");
  });

  it("has none for a closed task or one without a next step", () => {
    expect(workTaskNextStep(task({ state: "done", nextStep: "Old" }), "Scout")).toBeNull();
    expect(workTaskNextStep(task(), "Scout")).toBeNull();
  });
});

describe("workTaskActions", () => {
  it("offers approval only when the move is the user's", () => {
    expect(workTaskActions(task({ nextActor: "user" }))).toEqual([
      "approve",
      "done",
      "backlog",
      "cancel",
    ]);
    expect(workTaskActions(task())).toEqual(["done", "backlog", "cancel"]);
  });

  it("does not offer the backlog to a parked task", () => {
    expect(workTaskActions(task({ status: "backlog" }))).toEqual(["done", "cancel"]);
  });

  it("only reopens a closed task", () => {
    expect(workTaskActions(task({ state: "done", status: "done" }))).toEqual(["reopen"]);
    expect(workTaskActions(task({ state: "dropped", status: "canceled" }))).toEqual(["reopen"]);
  });
});

describe("work task messages", () => {
  it("names the task by title and id", () => {
    expect(buildWorkTaskMessage(task(), "  Use the staging build.  ")).toBe(
      'About task "Ship the Work tab" (task-1): Use the staging build.',
    );
  });

  it("approves the written next step", () => {
    expect(
      workTaskActionInstruction(task({ nextActor: "user", nextStep: "Merge #12" }), "approve"),
    ).toBe("Approved: Merge #12");
    expect(workTaskActionInstruction(task({ nextActor: "user" }), "approve")).toBe(
      "Approved. Go ahead.",
    );
  });

  it("asks the coordinator to make each state change", () => {
    expect(buildWorkTaskMessage(task(), workTaskActionInstruction(task(), "cancel"))).toBe(
      'About task "Ship the Work tab" (task-1): Please cancel it and close it as dropped.',
    );
    expect(workTaskActionInstruction(task(), "backlog")).toMatch(/backlog/);
    expect(workTaskActionInstruction(task(), "done")).toMatch(/done/);
  });
});

describe("workTaskProgressDisplay", () => {
  it("draws a metric's history as a sparkline", () => {
    const display = workTaskProgressDisplay({
      kind: "metric",
      text: "Recall 80%",
      values: [70, 80],
    });
    expect(display).toMatchObject({ text: "Recall 80%", provisional: false, fraction: null });
    expect(display?.sparkline).toBe("0,14 56,0");
  });

  it("leaves out a sparkline with too little history", () => {
    expect(
      workTaskProgressDisplay({ kind: "metric", text: "Recall 80%", values: [80] })?.sparkline,
    ).toBeNull();
  });

  it("draws a count as a bar and a pending baseline as provisional", () => {
    expect(workTaskProgressDisplay({ kind: "count", text: "3 / 4", fraction: 0.75 })).toEqual({
      text: "3 / 4",
      provisional: false,
      sparkline: null,
      fraction: 0.75,
    });
    expect(
      workTaskProgressDisplay({ kind: "pending", text: "baseline pending" })?.provisional,
    ).toBe(true);
    expect(workTaskProgressDisplay(null)).toBeNull();
  });
});

describe("work task links", () => {
  it("tells pull requests and Slack from other links", () => {
    expect(workTaskLinkKind("https://github.com/affil-ai/t3/pull/12")).toBe("pull-request");
    expect(workTaskLinkKind("https://affil.slack.com/archives/C1/p1")).toBe("slack");
    expect(workTaskLinkKind("https://example.com")).toBe("link");
  });
});
