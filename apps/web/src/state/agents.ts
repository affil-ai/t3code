/**
 * Fork-only Agents mode atoms: the agent list and each agent's task board,
 * read from the same environment that serves Firstmate. Kept out of the
 * upstream environment state.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  FIRSTMATE_AGENT_ID,
  FIRSTMATE_WS_METHODS,
  type AgentProfile,
  type AgentProfileId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";

function createAgentsEnvironmentAtoms(runtime: typeof connectionAtomRuntime) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agents:live",
      tag: FIRSTMATE_WS_METHODS.agentsSubscribe,
    }),
    tasks: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agents:tasks",
      tag: FIRSTMATE_WS_METHODS.agentTasksSubscribe,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:create",
      tag: FIRSTMATE_WS_METHODS.agentCreate,
      scheduler,
      concurrency,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:update",
      tag: FIRSTMATE_WS_METHODS.agentUpdate,
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:archive",
      tag: FIRSTMATE_WS_METHODS.agentArchive,
      scheduler,
      concurrency,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:start",
      tag: FIRSTMATE_WS_METHODS.agentStart,
      scheduler,
      concurrency,
    }),
  };
}

export const agentsEnvironment = createAgentsEnvironmentAtoms(connectionAtomRuntime);

export interface AgentsHome {
  readonly environmentId: EnvironmentId;
  /** Every unarchived agent, Firstmate included, in creation order. */
  readonly agents: ReadonlyArray<AgentProfile>;
}

/**
 * The first connected environment, in catalog order, whose server answers
 * `agents.subscribe`. An environment still answering holds the place, so a
 * slow fork server is not skipped for a later one; null means none has it.
 */
const agentsHomeAtom = Atom.make((get): AgentsHome | null => {
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (presentation.connection.phase !== "connected" || presentation.serverConfig === null) {
      continue;
    }
    const result = get(agentsEnvironment.live({ environmentId, input: {} }));
    if (AsyncResult.isSuccess(result)) return { environmentId, agents: result.value.agents };
    if (AsyncResult.isFailure(result)) continue;
    return null;
  }
  return null;
}).pipe(Atom.withLabel("agents:home"));

export function useAgentsHome(): AgentsHome | null {
  return useAtomValue(agentsHomeAtom);
}

/** The current agents home, read once outside React, as event handlers do. */
export function readAgentsHome(): AgentsHome | null {
  return appAtomRegistry.get(agentsHomeAtom);
}

/** One agent's board, shaped like Firstmate's snapshot. */
export function useAgentTasks(environmentId: EnvironmentId | null, agentId: AgentProfileId | null) {
  return useEnvironmentQuery(
    environmentId === null || agentId === null
      ? null
      : agentsEnvironment.tasks({ environmentId, input: { agentId } }),
  );
}

const NO_WORKER_THREAD_KEYS: ReadonlySet<string> = new Set();

/**
 * The worker chats of every custom agent's tasks, as scoped keys. Those chats
 * are reached from the agent's task list in the sidebar, so Firstmate's
 * Pinned, Projects, and Chats leave them out. Boards still loading add
 * nothing yet.
 */
const customAgentWorkerThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const home = get(agentsHomeAtom);
  if (home === null) return NO_WORKER_THREAD_KEYS;
  const keys = new Set<string>();
  for (const agent of home.agents) {
    if (agent.id === FIRSTMATE_AGENT_ID) continue;
    const result = get(
      agentsEnvironment.tasks({ environmentId: home.environmentId, input: { agentId: agent.id } }),
    );
    if (!AsyncResult.isSuccess(result)) continue;
    for (const task of result.value.tasks) {
      if (task.workerThreadId === null) continue;
      keys.add(scopedThreadKey(scopeThreadRef(home.environmentId, task.workerThreadId)));
    }
  }
  return keys.size === 0 ? NO_WORKER_THREAD_KEYS : keys;
}).pipe(Atom.withLabel("agents:custom-worker-thread-keys"));

export function useCustomAgentWorkerThreadKeys(): ReadonlySet<string> {
  return useAtomValue(customAgentWorkerThreadKeysAtom);
}

const NO_THREAD_AGENTS: ReadonlyMap<string, AgentProfileId> = new Map();

/**
 * Which agent a thread belongs to, by scoped thread key: every agent's
 * coordinator chat, and the worker chats on each agent's board. The sidebar
 * follows this when the route changes, so back and forward land on the
 * agent whose chat is open.
 */
const agentByThreadKeyAtom = Atom.make((get): ReadonlyMap<string, AgentProfileId> => {
  const home = get(agentsHomeAtom);
  if (home === null) return NO_THREAD_AGENTS;
  const byKey = new Map<string, AgentProfileId>();
  for (const agent of home.agents) {
    if (agent.coordinatorThreadId !== null) {
      byKey.set(
        scopedThreadKey(scopeThreadRef(home.environmentId, agent.coordinatorThreadId)),
        agent.id,
      );
    }
    const result = get(
      agentsEnvironment.tasks({ environmentId: home.environmentId, input: { agentId: agent.id } }),
    );
    if (!AsyncResult.isSuccess(result)) continue;
    for (const task of result.value.tasks) {
      if (task.workerThreadId === null) continue;
      byKey.set(scopedThreadKey(scopeThreadRef(home.environmentId, task.workerThreadId)), agent.id);
    }
  }
  return byKey.size === 0 ? NO_THREAD_AGENTS : byKey;
}).pipe(Atom.withLabel("agents:by-thread-key"));

export function useAgentByThreadKey(): ReadonlyMap<string, AgentProfileId> {
  return useAtomValue(agentByThreadKeyAtom);
}
