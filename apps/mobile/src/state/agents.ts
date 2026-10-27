/**
 * Fork-only agent state for the Work screens: the agent list, each agent's
 * board, the thread lookups that file chats under their agent, and the agent
 * mutations, bound to this app's runtime. The atoms are shared with web
 * through client-runtime.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type AgentsHome,
  createAgentsEnvironmentAtoms,
  createAgentsHomeAtoms,
} from "@t3tools/client-runtime/state/agents";
import type { AgentProfileId, EnvironmentId, FirstmateTask } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export type { AgentsHome };

export const agentsEnvironment = createAgentsEnvironmentAtoms(connectionAtomRuntime);

const agentsHome = createAgentsHomeAtoms({
  presentationsAtom: environmentPresentations.presentationsAtom,
  live: agentsEnvironment.live,
  tasks: agentsEnvironment.tasks,
});

/** The first connected environment whose server serves agents, with every unarchived agent. */
export function useAgentsHome(): AgentsHome | null {
  return useAtomValue(agentsHome.homeAtom);
}

/** One agent's live board, shaped like Firstmate's snapshot. */
export function useAgentTasks(environmentId: EnvironmentId | null, agentId: AgentProfileId | null) {
  return useEnvironmentQuery(
    environmentId === null || agentId === null
      ? null
      : agentsEnvironment.tasks({ environmentId, input: { agentId } }),
  );
}

/**
 * Every open standup task across boards, oldest standup first, each with its
 * owner (archived ones included), from the list web's sidebar and the widget
 * read.
 */
export function useStandupTasks(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : agentsEnvironment.standup({ environmentId, input: {} }),
  );
}

/** Every agent's coordinator chat, Firstmate's included, as scoped thread keys. */
export function useAgentCoordinatorThreadKeys(): ReadonlySet<string> {
  return useAtomValue(agentsHome.coordinatorThreadKeysAtom);
}

/** Every custom agent's worker chats, as scoped thread keys; Firstmate's chat lists leave them out. */
export function useCustomAgentWorkerThreadKeys(): ReadonlySet<string> {
  return useAtomValue(agentsHome.customAgentWorkerThreadKeysAtom);
}

/*
 * One chat's entry in the lookups. Each selects only that chat's value, so a
 * board update re-renders an open chat only when its own task or agent moved.
 */

/** Whether a chat, by scoped thread key, is any agent's coordinator chat. */
export function useIsAgentCoordinatorThread(threadKey: string | null): boolean {
  return useAtomValue(agentsHome.coordinatorThreadKeysAtom, (keys) =>
    threadKey === null ? false : keys.has(threadKey),
  );
}

/** Whether a chat, by scoped thread key, is a custom agent's worker chat. */
export function useIsCustomAgentWorkerThread(threadKey: string | null): boolean {
  return useAtomValue(agentsHome.customAgentWorkerThreadKeysAtom, (keys) =>
    threadKey === null ? false : keys.has(threadKey),
  );
}

/** The agent a coordinator or worker chat belongs to, by scoped thread key. */
export function useThreadAgentId(threadKey: string | null): AgentProfileId | null {
  return useAtomValue(agentsHome.agentByThreadKeyAtom, (byKey) =>
    threadKey === null ? null : (byKey.get(threadKey) ?? null),
  );
}

/** The task whose worker a chat is, by scoped thread key. */
export function useWorkerThreadTask(threadKey: string | null): FirstmateTask | null {
  return useAtomValue(agentsHome.taskByWorkerThreadKeyAtom, (byKey) =>
    threadKey === null ? null : (byKey.get(threadKey) ?? null),
  );
}

/**
 * The agent mutations and whether this connection may run each one. Each
 * command resolves to an `AtomCommandResult`; failures are only logged, so
 * callers show their own error (see `Dialog.alert`).
 */
export function useAgentCommands(environmentId: EnvironmentId | null) {
  return {
    create: useAtomCommand(agentsEnvironment.create),
    update: useAtomCommand(agentsEnvironment.update),
    archive: useAtomCommand(agentsEnvironment.archive),
    start: useAtomCommand(agentsEnvironment.start),
    can: {
      create: useAtomValue(agentsEnvironment.create.permissionAtom(environmentId)),
      update: useAtomValue(agentsEnvironment.update.permissionAtom(environmentId)),
      archive: useAtomValue(agentsEnvironment.archive.permissionAtom(environmentId)),
      start: useAtomValue(agentsEnvironment.start.permissionAtom(environmentId)),
    },
  };
}
