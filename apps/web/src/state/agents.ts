/**
 * Fork-only agent atoms: the agent list and each agent's task board, read
 * from the first environment that serves agents. Kept out of the upstream
 * environment state; the atoms themselves live in client-runtime.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type AgentsHome,
  createAgentsEnvironmentAtoms,
  createAgentsHomeAtoms,
} from "@t3tools/client-runtime/state/agents";
import type {
  AgentProfileId,
  EnvironmentId,
  FirstmateTask,
  StandupTaskEntry,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";

export type { AgentsHome };

export const agentsEnvironment = createAgentsEnvironmentAtoms(connectionAtomRuntime);

const agentsHome = createAgentsHomeAtoms({
  presentationsAtom: environmentPresentations.presentationsAtom,
  live: agentsEnvironment.live,
  tasks: agentsEnvironment.tasks,
});

export function useAgentsHome(): AgentsHome | null {
  return useAtomValue(agentsHome.homeAtom);
}

/** The current agents home, read once outside React, as event handlers do. */
export function readAgentsHome(): AgentsHome | null {
  return appAtomRegistry.get(agentsHome.homeAtom);
}

/** One agent's board, shaped like Firstmate's snapshot. */
export function useAgentTasks(environmentId: EnvironmentId | null, agentId: AgentProfileId | null) {
  return useEnvironmentQuery(
    environmentId === null || agentId === null
      ? null
      : agentsEnvironment.tasks({ environmentId, input: { agentId } }),
  );
}

/** A standup task and its owner, who may be archived. */
export type StandupTaskRow = StandupTaskEntry;

const NO_STANDUP_TASKS: ReadonlyArray<StandupTaskRow> = [];

/**
 * Every open standup task across boards, oldest standup first, from the same
 * server list the MCP tools and the widget read, so an archived owner's tasks
 * stay. Firstmate's sidebar shows all of them; another agent's shows its own.
 */
const standupTasksAtom = Atom.make((get): ReadonlyArray<StandupTaskRow> => {
  const home = get(agentsHome.homeAtom);
  if (home === null) return NO_STANDUP_TASKS;
  const result = get(agentsEnvironment.standup({ environmentId: home.environmentId, input: {} }));
  return AsyncResult.isSuccess(result) ? result.value.tasks : NO_STANDUP_TASKS;
}).pipe(Atom.withLabel("agents:standup-tasks"));

export function useStandupTasks(): ReadonlyArray<StandupTaskRow> {
  return useAtomValue(standupTasksAtom);
}

/**
 * The worker chats of every custom agent's tasks, as scoped keys. Those chats
 * are reached from the agent's task list in the sidebar, so Firstmate's
 * Pinned, Projects, and Chats leave them out.
 */
export function useCustomAgentWorkerThreadKeys(): ReadonlySet<string> {
  return useAtomValue(agentsHome.customAgentWorkerThreadKeysAtom);
}

/**
 * Which agent a thread belongs to, by scoped thread key. The sidebar follows
 * this when the route changes, so back and forward land on the agent whose
 * chat is open.
 */
export function useAgentByThreadKey(): ReadonlyMap<string, AgentProfileId> {
  return useAtomValue(agentsHome.agentByThreadKeyAtom);
}

/**
 * Which task owns a worker chat, by scoped thread key. The sidebar and thread
 * hover card use this to show task context without changing the thread model.
 */
export function useTaskByWorkerThreadKey(): ReadonlyMap<string, FirstmateTask> {
  return useAtomValue(agentsHome.taskByWorkerThreadKeyAtom);
}
