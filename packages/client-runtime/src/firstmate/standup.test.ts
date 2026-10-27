import {
  AgentProfileId,
  FIRSTMATE_AGENT_ID,
  type AgentProfile,
  type FirstmateTask,
  FirstmateTaskId,
  type StandupItem,
  StandupItemId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { standupNeedsYouCount, standupStartedLabel, standupTarget } from "./standup.ts";

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
    ...overrides,
  }) as FirstmateTask;
const item = (overrides: Partial<StandupItem>): StandupItem => ({
  id: StandupItemId.make("standup:1"),
  text: "simplify page/link system",
  agentId: null,
  task: null,
  startedAt: "2026-10-27T16:00:00.000Z",
  finishedAt: null,
  archivedAt: null,
  ...overrides,
});

describe("standupTarget", () => {
  it("opens another agent's worker chat", () => {
    const worker = ThreadId.make("joan-worker");
    expect(
      standupTarget(item({ agentId: JOAN, task: task({ workerThreadId: worker }) }), agents),
    ).toEqual({ kind: "thread", threadId: worker });
  });

  it("opens the owner's chat on the task when it has no worker", () => {
    expect(standupTarget(item({ agentId: JOAN, task: task({}) }), agents)).toEqual({
      kind: "task",
      coordinatorThreadId: ThreadId.make("joan-chat"),
      taskId: "task-1",
    });
  });

  it("opens Firstmate for an item with no task, and nothing when its chat is gone", () => {
    expect(standupTarget(item({}), agents)).toEqual({
      kind: "thread",
      threadId: ThreadId.make("firstmate-chat"),
    });
    expect(standupTarget(item({}), [agent(FIRSTMATE_AGENT_ID, null)])).toBeNull();
  });
});

describe("standupNeedsYouCount", () => {
  it("counts tasks waiting on the user and ready to deploy, not parked ones", () => {
    expect(
      standupNeedsYouCount([
        item({ task: task({ nextActor: "user" }) }),
        item({ task: task({ status: "ready_for_deployment", nextActor: "coordinator" }) }),
        item({ task: task({ status: "backlog", nextActor: "user" }) }),
        item({}),
      ]),
    ).toBe(2);
  });
});

describe("standupStartedLabel", () => {
  it("adds the year only for another year", () => {
    const now = DateTime.toDate(DateTime.makeUnsafe("2026-10-27T18:00:00.000Z"));
    expect(standupStartedLabel("2026-10-20T18:00:00.000Z", now)).toMatch(/^started .*20/);
    expect(standupStartedLabel("2026-10-20T18:00:00.000Z", now)).not.toContain("2026");
    expect(standupStartedLabel("2025-10-20T18:00:00.000Z", now)).toContain("2025");
  });
});
