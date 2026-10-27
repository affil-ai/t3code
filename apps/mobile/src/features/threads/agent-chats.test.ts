import { agentCoordinatorThreadKeys } from "@t3tools/client-runtime/firstmate/chat-lists";
import {
  type AgentProfile,
  AgentProfileId,
  EnvironmentId,
  FIRSTMATE_AGENT_ID,
  type FirstmateTask,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import {
  hiddenAgentChatKeys,
  resolveThreadAgentContext,
  threadWorkspaceTab,
  withoutAgentChats,
  withoutAgentHomeProjects,
} from "./agent-chats";

const environmentId = EnvironmentId.make("env-1");
const otherEnvironmentId = EnvironmentId.make("env-2");
const scoutId = AgentProfileId.make("scout");

function agent(id: AgentProfileId, name: string, coordinatorThreadId: string | null) {
  return {
    id,
    name,
    coordinatorThreadId: coordinatorThreadId === null ? null : ThreadId.make(coordinatorThreadId),
    homeProjectId: null,
  } as unknown as AgentProfile;
}

const firstmate = agent(FIRSTMATE_AGENT_ID, "Firstmate", "firstmate-chat");
const scout = agent(scoutId, "Scout", "scout-chat");
const home = { environmentId, agents: [firstmate, scout] };

function thread(id: string, env = environmentId) {
  return { environmentId: env, id: ThreadId.make(id), title: id };
}

function key(id: string, env = environmentId) {
  return scopedThreadKey(env, ThreadId.make(id));
}

const scoutTask = { id: "task-1", workerThreadId: ThreadId.make("scout-worker") } as FirstmateTask;

describe("agent chats in the Threads lists", () => {
  // Firstmate's worker chats are not in the custom-agent worker set, so they stay listed.
  const hidden = hiddenAgentChatKeys(
    agentCoordinatorThreadKeys(home),
    new Set([key("scout-worker")]),
  );

  it("leaves out every coordinator chat and custom agents' worker chats", () => {
    const threads = [
      thread("firstmate-chat"),
      thread("scout-chat"),
      thread("scout-worker"),
      thread("firstmate-worker"),
      thread("plain"),
    ];
    expect(withoutAgentChats(threads, hidden).map((entry) => entry.id)).toEqual([
      "firstmate-worker",
      "plain",
    ]);
  });

  it("matches by environment, not only thread id", () => {
    const threads = [thread("scout-chat", otherEnvironmentId)];
    expect(withoutAgentChats(threads, hidden)).toBe(threads);
  });

  it("keeps the same list when nothing is hidden, so memoized rows stay put", () => {
    const threads = [thread("plain")];
    expect(withoutAgentChats(threads, hidden)).toBe(threads);
    expect(withoutAgentChats(threads, new Set())).toBe(threads);
  });

  it("files hidden agent chats under Work, everything else under Threads", () => {
    expect(threadWorkspaceTab({ hidden: true, agentChat: true, workSelected: false })).toBe("work");
    expect(threadWorkspaceTab({ hidden: false, agentChat: false, workSelected: true })).toBe(
      "threads",
    );
  });

  it("keeps a listed agent chat under Work only when it was opened from Work", () => {
    // Firstmate's worker chats stay in the Threads lists but belong to an agent.
    expect(threadWorkspaceTab({ hidden: false, agentChat: true, workSelected: true })).toBe("work");
    expect(threadWorkspaceTab({ hidden: false, agentChat: true, workSelected: false })).toBe(
      "threads",
    );
  });

  it("reuses a set when the other one is empty", () => {
    const coordinators = new Set([key("scout-chat")]);
    expect(hiddenAgentChatKeys(coordinators, new Set())).toBe(coordinators);
    expect(hiddenAgentChatKeys(new Set(), coordinators)).toBe(coordinators);
  });
});

describe("thread agent context", () => {
  const taskByWorkerThreadKey = new Map([[key("scout-worker"), scoutTask]]);
  const agentByThreadKey = new Map([
    [key("scout-worker"), scoutId],
    [key("scout-chat"), scoutId],
  ]);
  const resolve = (threadId: string, env = environmentId) =>
    resolveThreadAgentContext({
      environmentId: env,
      threadId: ThreadId.make(threadId),
      task: taskByWorkerThreadKey.get(key(threadId, env)) ?? null,
      agentId: agentByThreadKey.get(key(threadId, env)) ?? null,
      home,
    });

  it("links a worker chat to its task and the board it is on", () => {
    expect(resolve("scout-worker")).toEqual({
      task: scoutTask,
      agentId: scoutId,
      coordinatorAgent: null,
    });
  });

  it("names the agent on its coordinator chat, Firstmate's included", () => {
    expect(resolve("scout-chat").coordinatorAgent?.name).toBe("Scout");
    expect(resolve("firstmate-chat")).toEqual({
      task: null,
      agentId: FIRSTMATE_AGENT_ID,
      coordinatorAgent: firstmate,
    });
  });

  it("knows nothing about other chats or other environments", () => {
    const none = { task: null, agentId: null, coordinatorAgent: null };
    expect(resolve("plain")).toEqual(none);
    expect(resolve("scout-chat", otherEnvironmentId)).toEqual(none);
  });
});

describe("agent home projects", () => {
  const project = (id: string, env = environmentId) => ({
    environmentId: env,
    id: ProjectId.make(id),
  });
  const homeKeys = new Set([scopedProjectKey(environmentId, ProjectId.make("scout-home"))]);

  it("leaves agents' home projects out of the project choices", () => {
    const projects = [
      project("scout-home"),
      project("app"),
      project("scout-home", otherEnvironmentId),
    ];
    expect(withoutAgentHomeProjects(projects, homeKeys).map((entry) => entry.id)).toEqual([
      "app",
      "scout-home",
    ]);
  });

  it("keeps the same list when nothing is skipped", () => {
    const projects = [project("app")];
    expect(withoutAgentHomeProjects(projects, homeKeys)).toBe(projects);
    expect(withoutAgentHomeProjects(projects, new Set())).toBe(projects);
  });
});
