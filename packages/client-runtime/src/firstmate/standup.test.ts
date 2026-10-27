import {
  AgentProfileId,
  FIRSTMATE_AGENT_ID,
  type AgentProfile,
  type FirstmateTask,
  FirstmateTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { standupRowsForAgent, standupTarget } from "./standup.ts";

const JOAN = AgentProfileId.make("agent:joan");
const agent = (id: AgentProfileId, chat: string | null) =>
  ({ id, coordinatorThreadId: chat === null ? null : ThreadId.make(chat) }) as AgentProfile;
const agents = [agent(FIRSTMATE_AGENT_ID, "firstmate-chat"), agent(JOAN, "joan-chat")];

const task = (overrides: Partial<FirstmateTask>) =>
  ({
    id: FirstmateTaskId.make("task-1"),
    state: "open",
    status: "in_progress",
    nextActor: "worker",
    workerThreadId: null,
    standup: { startedAt: "2026-10-27T16:00:00.000Z", finishedAt: null },
    ...overrides,
  }) as FirstmateTask;

describe("standupTarget", () => {
  it("opens another agent's worker chat", () => {
    const worker = ThreadId.make("joan-worker");
    expect(standupTarget(task({ workerThreadId: worker }), JOAN, agents)).toEqual({
      kind: "thread",
      threadId: worker,
    });
  });

  it("opens the owner's chat on the task when it has no worker", () => {
    expect(standupTarget(task({}), JOAN, agents)).toEqual({
      kind: "task",
      coordinatorThreadId: ThreadId.make("joan-chat"),
      taskId: "task-1",
    });
  });

  it("falls back to Firstmate's chat when the owner is archived", () => {
    // The active list leaves archived agents out; their open tasks stay on the standup.
    const active = [agent(FIRSTMATE_AGENT_ID, "firstmate-chat")];
    expect(standupTarget(task({}), JOAN, active)).toEqual({
      kind: "thread",
      threadId: ThreadId.make("firstmate-chat"),
    });
    const worker = ThreadId.make("joan-worker");
    expect(standupTarget(task({ workerThreadId: worker }), JOAN, active)).toEqual({
      kind: "thread",
      threadId: worker,
    });
    expect(standupTarget(task({}), JOAN, [agent(FIRSTMATE_AGENT_ID, null)])).toBeNull();
  });
});

describe("standupRowsForAgent", () => {
  const MAKE_MONEY_MOVE = AgentProfileId.make("agent:make-money-move");
  const firstmate = { id: FIRSTMATE_AGENT_ID, icon: "compass" };
  const makeMoneyMove = { id: MAKE_MONEY_MOVE, icon: "banknote" };
  const joan = { id: JOAN, icon: "shield" };
  // The standup list as the server sends it: oldest standup first, across boards.
  const rows = (
    [
      [firstmate, "fm-1"],
      [joan, "joan-1"],
      [makeMoneyMove, "mmm-1"],
      [joan, "joan-2"],
      [firstmate, "fm-2"],
      [makeMoneyMove, "mmm-2"],
      [joan, "joan-3"],
    ] as const
  ).map(([agent, id]) => ({ agent, task: task({ id: FirstmateTaskId.make(id) }) }));

  it("lists every agent's standup tasks under Firstmate, each with its owner", () => {
    const listed = standupRowsForAgent(rows, FIRSTMATE_AGENT_ID);
    expect(listed.map((row) => [row.agent.icon, row.task.id])).toEqual([
      ["compass", "fm-1"],
      ["shield", "joan-1"],
      ["banknote", "mmm-1"],
      ["shield", "joan-2"],
      ["compass", "fm-2"],
      ["banknote", "mmm-2"],
      ["shield", "joan-3"],
    ]);
  });

  it("lists only an agent's own standup tasks under that agent", () => {
    expect(standupRowsForAgent(rows, JOAN).map((row) => row.task.id)).toEqual([
      "joan-1",
      "joan-2",
      "joan-3",
    ]);
    expect(standupRowsForAgent(rows, MAKE_MONEY_MOVE)).toHaveLength(2);
  });
});
