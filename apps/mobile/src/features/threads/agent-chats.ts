/**
 * fork: agents. Which chats belong to agents rather than the Threads lists,
 * and what a chat's header knows about its agent or task.
 *
 * Like web's chat lists, the Threads lists leave out every agent's
 * coordinator chat (each has its own place in the Work tab) and the worker
 * chats of custom agents' tasks (reached from that agent's tasks). Firstmate's
 * worker chats stay listed. The command palette still finds all of them.
 */
import type {
  AgentProfile,
  AgentProfileId,
  EnvironmentId,
  FirstmateTask,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";

/** The scoped thread keys the Threads lists leave out. */
export function hiddenAgentChatKeys(
  coordinatorThreadKeys: ReadonlySet<string>,
  customAgentWorkerThreadKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  if (coordinatorThreadKeys.size === 0) return customAgentWorkerThreadKeys;
  if (customAgentWorkerThreadKeys.size === 0) return coordinatorThreadKeys;
  const keys = new Set(coordinatorThreadKeys);
  for (const key of customAgentWorkerThreadKeys) keys.add(key);
  return keys;
}

/** The threads without agent chats; returns the input itself when nothing is hidden. */
export function withoutAgentChats<
  Thread extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(threads: ReadonlyArray<Thread>, hiddenKeys: ReadonlySet<string>): ReadonlyArray<Thread> {
  if (hiddenKeys.size === 0) return threads;
  const visible = threads.filter(
    (thread) => !hiddenKeys.has(scopedThreadKey(thread.environmentId, thread.id)),
  );
  return visible.length === threads.length ? threads : visible;
}

/**
 * The workspace tab a chat belongs to. Android selects it while the chat is
 * open, so an agent chat opened from Work keeps Work's list beside it and
 * returns there, instead of a Threads list that leaves the chat out. A chat
 * the Threads lists keep (Firstmate's worker chats) stays with Work only
 * when it was opened from Work.
 */
export function threadWorkspaceTab(chat: {
  /** The Threads lists leave this chat out. */
  readonly hidden: boolean;
  /** The chat belongs to an agent: its coordinator chat or a task's worker chat. */
  readonly agentChat: boolean;
  /** Work is the selected tab. */
  readonly workSelected: boolean;
}): "threads" | "work" {
  return chat.hidden || (chat.agentChat && chat.workSelected) ? "work" : "threads";
}

/**
 * The projects new chats can use: every agent's home project runs only its
 * coordinator, so the project choices skip it, as on web. Returns the input
 * itself when nothing is skipped.
 */
export function withoutAgentHomeProjects<
  Project extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(projects: ReadonlyArray<Project>, homeProjectKeys: ReadonlySet<string>): ReadonlyArray<Project> {
  if (homeProjectKeys.size === 0) return projects;
  const kept = projects.filter(
    (project) => !homeProjectKeys.has(scopedProjectKey(project.environmentId, project.id)),
  );
  return kept.length === projects.length ? projects : kept;
}

export interface ThreadAgentContext {
  /** The task whose worker this chat is, if any. */
  readonly task: FirstmateTask | null;
  /** The agent whose board holds that task, or whose coordinator this chat is. */
  readonly agentId: AgentProfileId | null;
  /** The agent, when this chat is its coordinator chat. */
  readonly coordinatorAgent: AgentProfile | null;
}

const NO_AGENT_CONTEXT: ThreadAgentContext = {
  task: null,
  agentId: null,
  coordinatorAgent: null,
};

/** What an open chat's header shows about its agent: its task, or the agent it coordinates for. */
export function resolveThreadAgentContext(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /** The task whose worker this chat is, from the worker-chat lookup. */
  readonly task: FirstmateTask | null;
  /** The agent this chat belongs to, from the thread lookup. */
  readonly agentId: AgentProfileId | null;
  readonly home: {
    readonly environmentId: EnvironmentId;
    readonly agents: ReadonlyArray<AgentProfile>;
  } | null;
}): ThreadAgentContext {
  if (input.environmentId === null || input.threadId === null) return NO_AGENT_CONTEXT;
  const { task, agentId } = input;
  const coordinatorAgent =
    input.home !== null && input.home.environmentId === input.environmentId
      ? (input.home.agents.find((agent) => agent.coordinatorThreadId === input.threadId) ?? null)
      : null;
  if (task === null && agentId === null && coordinatorAgent === null) return NO_AGENT_CONTEXT;
  return { task, agentId: agentId ?? coordinatorAgent?.id ?? null, coordinatorAgent };
}
