import {
  AgentProfileId,
  FIRSTMATE_AGENT_ID,
  type AgentProfile,
  type FirstmateTask,
  FirstmateTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { standupTarget } from "./standupSection.logic";

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
