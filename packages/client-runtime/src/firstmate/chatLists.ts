/**
 * Which chats and projects belong to agents rather than the user's chat
 * lists. Every coordinator chat has its own row in the agent switcher, so
 * chat lists leave it out (search still finds it), and an agent's home
 * project runs only its coordinator, so new chats skip it.
 *
 * @module firstmate/chatLists
 */
import type {
  AgentProfile,
  EnvironmentId,
  FirstmateTask,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "../environment/index.ts";

/** The agents served by one environment, as `agents.subscribe` reports them. */
export interface AgentsHomeAgents {
  readonly environmentId: EnvironmentId;
  readonly agents: ReadonlyArray<
    Pick<AgentProfile, "id" | "coordinatorThreadId" | "homeProjectId">
  >;
}

export const NO_FIRSTMATE_COORDINATOR_KEYS: ReadonlySet<string> = new Set();

/** The scoped key of the coordinator chat, as a set the lists can filter by. */
export function firstmateCoordinatorThreadKeys(
  environmentId: EnvironmentId | null,
  coordinatorThreadId: ThreadId | null,
): ReadonlySet<string> {
  if (environmentId === null || coordinatorThreadId === null) return NO_FIRSTMATE_COORDINATOR_KEYS;
  return new Set([scopedThreadKey(scopeThreadRef(environmentId, coordinatorThreadId))]);
}

export const NO_FIRSTMATE_HOME_PROJECT_KEYS: ReadonlySet<string> = new Set();

/** The scoped key of Firstmate's home project, as a set new chats can skip. */
export function firstmateHomeProjectKeys(
  environmentId: EnvironmentId | null,
  homeProjectId: ProjectId | null | undefined,
): ReadonlySet<string> {
  if (environmentId === null || homeProjectId == null) return NO_FIRSTMATE_HOME_PROJECT_KEYS;
  return new Set([scopedProjectKey(scopeProjectRef(environmentId, homeProjectId))]);
}

/** Every agent's coordinator chat, Firstmate's included, as scoped thread keys. */
export function agentCoordinatorThreadKeys(home: AgentsHomeAgents | null): ReadonlySet<string> {
  if (home === null) return NO_FIRSTMATE_COORDINATOR_KEYS;
  return new Set(
    home.agents.flatMap((agent) =>
      agent.coordinatorThreadId === null
        ? []
        : [scopedThreadKey(scopeThreadRef(home.environmentId, agent.coordinatorThreadId))],
    ),
  );
}

/** Every agent's home project, as scoped project keys new chats skip. */
export function agentHomeProjectKeys(home: AgentsHomeAgents | null): ReadonlySet<string> {
  if (home === null) return NO_FIRSTMATE_HOME_PROJECT_KEYS;
  return new Set(
    home.agents.flatMap((agent) =>
      agent.homeProjectId === null
        ? []
        : [scopedProjectKey(scopeProjectRef(home.environmentId, agent.homeProjectId))],
    ),
  );
}

/**
 * Whether a chat is an agent's coordinator chat. Such a chat runs in its
 * agent's home project, which carries the agent's name, so a chat header
 * leaves the project out rather than show the name twice.
 */
export function isAgentCoordinatorChat(
  home: AgentsHomeAgents | null,
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null | undefined,
): boolean {
  if (home === null || environmentId === null || threadId == null) return false;
  if (home.environmentId !== environmentId) return false;
  return home.agents.some((agent) => agent.coordinatorThreadId === threadId);
}

/** The scoped key of a task's worker chat, or null without one. */
export function workerThreadKey(
  environmentId: EnvironmentId,
  task: Pick<FirstmateTask, "workerThreadId">,
): string | null {
  return task.workerThreadId === null
    ? null
    : scopedThreadKey(scopeThreadRef(environmentId, task.workerThreadId));
}
