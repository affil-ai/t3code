/**
 * Fork-only agent atoms: the agent list and each agent's task board, read
 * from the first environment that serves agents, plus the thread lookups
 * chat lists use to file coordinator and worker chats under their agent.
 * Each client binds these to its own runtime and keeps its React hooks.
 *
 * @module state/agents
 */
import {
  FIRSTMATE_AGENT_ID,
  FIRSTMATE_WS_METHODS,
  type AgentProfile,
  type AgentProfileId,
  type AgentsSnapshot,
  type EnvironmentId,
  type FirstmateSnapshot,
  type FirstmateTask,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { agentCoordinatorThreadKeys } from "../firstmate/chatLists.ts";
import { scopedThreadKey, scopeThreadRef } from "../environment/index.ts";
import { createHomeEnvironmentAtom, type EnvironmentPresentationsAtom } from "./firstmate.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createAgentsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
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
    standup: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agents:standup",
      tag: FIRSTMATE_WS_METHODS.standupSubscribe,
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

export interface AgentsHome {
  readonly environmentId: EnvironmentId;
  /** Every unarchived agent, Firstmate included, in creation order. */
  readonly agents: ReadonlyArray<AgentProfile>;
}

const NO_THREAD_KEYS: ReadonlySet<string> = new Set();
const NO_THREAD_AGENTS: ReadonlyMap<string, AgentProfileId> = new Map();
const NO_WORKER_TASKS: ReadonlyMap<string, FirstmateTask> = new Map();

/** Whether two key sets hold the same keys, so a derived atom can keep its old set. */
export function sameKeySet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

/** Whether two maps hold the same entries, values compared by reference. */
function sameEntries<V>(left: ReadonlyMap<string, V>, right: ReadonlyMap<string, V>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key) || !Object.is(right.get(key), value)) return false;
  }
  return true;
}

/**
 * The agents home and the lookups derived from every agent's board. Boards
 * still loading add nothing yet.
 */
export function createAgentsHomeAtoms(input: {
  readonly presentationsAtom: EnvironmentPresentationsAtom;
  readonly live: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: {};
  }) => Atom.Atom<AsyncResult.AsyncResult<AgentsSnapshot, unknown>>;
  readonly tasks: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly agentId: AgentProfileId };
  }) => Atom.Atom<AsyncResult.AsyncResult<FirstmateSnapshot, unknown>>;
}) {
  const homeEnvironmentAtom = createHomeEnvironmentAtom({
    label: "agents:home-environment",
    presentationsAtom: input.presentationsAtom,
    resultAtom: (environmentId) => input.live({ environmentId, input: {} }),
  });

  /** The first connected environment whose server answers `agents.subscribe`. */
  const homeAtom = Atom.make((get): AgentsHome | null => {
    const selected = get(homeEnvironmentAtom);
    return selected === null
      ? null
      : { environmentId: selected.environmentId, agents: selected.value.agents };
  }).pipe(
    // A presentation change alone rebuilds the selection; keep the same home
    // so the lookups below don't recompute and notify for nothing.
    Atom.withEquality<AgentsHome | null>(
      (left, right) =>
        left === right ||
        (left !== null &&
          right !== null &&
          left.environmentId === right.environmentId &&
          left.agents === right.agents),
    ),
    Atom.withLabel("agents:home"),
  );

  /** Each agent's loaded board, in agent order. */
  const forEachBoard = (
    get: Atom.AtomContext,
    home: AgentsHome,
    visit: (agent: AgentProfile, tasks: ReadonlyArray<FirstmateTask>) => void,
    include: (agent: AgentProfile) => boolean = () => true,
  ) => {
    for (const agent of home.agents) {
      // Skipped agents' boards are never read, so their streams stay closed.
      if (!include(agent)) continue;
      const result = get(
        input.tasks({ environmentId: home.environmentId, input: { agentId: agent.id } }),
      );
      visit(agent, AsyncResult.isSuccess(result) ? result.value.tasks : []);
    }
  };

  /** Every agent's coordinator chat, Firstmate's included, as scoped keys. */
  const coordinatorThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
    const keys = agentCoordinatorThreadKeys(get(homeAtom));
    return keys.size === 0 ? NO_THREAD_KEYS : keys;
  }).pipe(
    Atom.withEquality<ReadonlySet<string>>(sameKeySet),
    Atom.withLabel("agents:coordinator-thread-keys"),
  );

  /**
   * The worker chats of every custom agent's tasks, as scoped keys. Those
   * chats are reached from the agent's tasks, so Firstmate's chat lists
   * leave them out.
   */
  const customAgentWorkerThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
    const home = get(homeAtom);
    if (home === null) return NO_THREAD_KEYS;
    const keys = new Set<string>();
    forEachBoard(
      get,
      home,
      (_agent, tasks) => {
        for (const task of tasks) {
          if (task.workerThreadId === null) continue;
          keys.add(scopedThreadKey(scopeThreadRef(home.environmentId, task.workerThreadId)));
        }
      },
      (agent) => agent.id !== FIRSTMATE_AGENT_ID,
    );
    return keys.size === 0 ? NO_THREAD_KEYS : keys;
  }).pipe(
    Atom.withEquality<ReadonlySet<string>>(sameKeySet),
    Atom.withLabel("agents:custom-worker-thread-keys"),
  );

  /**
   * Which agent a thread belongs to, by scoped thread key: every agent's
   * coordinator chat, and the worker chats on each agent's board.
   */
  const agentByThreadKeyAtom = Atom.make((get): ReadonlyMap<string, AgentProfileId> => {
    const home = get(homeAtom);
    if (home === null) return NO_THREAD_AGENTS;
    const byKey = new Map<string, AgentProfileId>();
    forEachBoard(get, home, (agent, tasks) => {
      if (agent.coordinatorThreadId !== null) {
        byKey.set(
          scopedThreadKey(scopeThreadRef(home.environmentId, agent.coordinatorThreadId)),
          agent.id,
        );
      }
      for (const task of tasks) {
        if (task.workerThreadId === null) continue;
        byKey.set(
          scopedThreadKey(scopeThreadRef(home.environmentId, task.workerThreadId)),
          agent.id,
        );
      }
    });
    return byKey.size === 0 ? NO_THREAD_AGENTS : byKey;
  }).pipe(
    Atom.withEquality<ReadonlyMap<string, AgentProfileId>>(sameEntries),
    Atom.withLabel("agents:by-thread-key"),
  );

  /** Which task owns a worker chat, by scoped thread key. */
  const taskByWorkerThreadKeyAtom = Atom.make((get): ReadonlyMap<string, FirstmateTask> => {
    const home = get(homeAtom);
    if (home === null) return NO_WORKER_TASKS;
    const byKey = new Map<string, FirstmateTask>();
    forEachBoard(get, home, (_agent, tasks) => {
      for (const task of tasks) {
        if (task.workerThreadId === null) continue;
        byKey.set(scopedThreadKey(scopeThreadRef(home.environmentId, task.workerThreadId)), task);
      }
    });
    return byKey.size === 0 ? NO_WORKER_TASKS : byKey;
  }).pipe(
    Atom.withEquality<ReadonlyMap<string, FirstmateTask>>(sameEntries),
    Atom.withLabel("agents:task-by-worker-thread-key"),
  );

  return {
    homeAtom,
    coordinatorThreadKeysAtom,
    customAgentWorkerThreadKeysAtom,
    agentByThreadKeyAtom,
    taskByWorkerThreadKeyAtom,
  };
}
