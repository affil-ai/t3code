/**
 * fork: agents. Hooks over the agents home for the Threads lists, the
 * project choices, and the chat header; the rules live in `agent-chats.ts`.
 */
import { useMemo } from "react";

import { agentHomeProjectKeys } from "@t3tools/client-runtime/firstmate/chat-lists";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  useAgentCoordinatorThreadKeys,
  useAgentsHome,
  useCustomAgentWorkerThreadKeys,
  useIsAgentCoordinatorThread,
  useIsCustomAgentWorkerThread,
  useThreadAgentId,
  useWorkerThreadTask,
} from "../../state/agents";
import { useProjects } from "../../state/entities";
import { useFirstmateHomeProjectKey } from "../../state/firstmate";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import {
  hiddenAgentChatKeys,
  resolveThreadAgentContext,
  threadWorkspaceTab,
  withoutAgentHomeProjects,
} from "./agent-chats";

/** The scoped thread keys of agent chats the Threads lists leave out. */
export function useHiddenAgentChatKeys(): ReadonlySet<string> {
  const coordinators = useAgentCoordinatorThreadKeys();
  const customWorkers = useCustomAgentWorkerThreadKeys();
  // One set until either input changes, so the Threads lists don't re-filter.
  return useMemo(
    () => hiddenAgentChatKeys(coordinators, customWorkers),
    [coordinators, customWorkers],
  );
}

function threadKeyOf(environmentId: string | null, threadId: string | null): string | null {
  return environmentId && threadId
    ? scopedThreadKey(EnvironmentId.make(environmentId), ThreadId.make(threadId))
    : null;
}

/**
 * The workspace tab an open chat belongs to: Work for agent chats the Threads
 * lists leave out, and for any agent's chat opened from Work.
 */
export function useThreadWorkspaceTab(
  environmentId: string | null,
  threadId: string | null,
): "threads" | "work" {
  const key = threadKeyOf(environmentId, threadId);
  const coordinator = useIsAgentCoordinatorThread(key);
  const customWorker = useIsCustomAgentWorkerThread(key);
  const agentChat = useThreadAgentId(key) !== null;
  const workSelected = useWorkspaceTabs()?.state.selectedTab === "work";
  return threadWorkspaceTab({ hidden: coordinator || customWorker, agentChat, workSelected });
}

/** The task or agent an open chat belongs to, for its header. */
export function useThreadAgentContext(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
) {
  const key = environmentId && threadId ? scopedThreadKey(environmentId, threadId) : null;
  return resolveThreadAgentContext({
    environmentId,
    threadId,
    task: useWorkerThreadTask(key),
    agentId: useThreadAgentId(key),
    home: useAgentsHome(),
  });
}

/** Every agent's home project, Firstmate's included, as scoped project keys. */
function useAgentHomeProjectKeys(): ReadonlySet<string> {
  const agentKeys = agentHomeProjectKeys(useAgentsHome());
  const firstmateKey = useFirstmateHomeProjectKey();
  return firstmateKey === null || agentKeys.has(firstmateKey)
    ? agentKeys
    : new Set([...agentKeys, firstmateKey]);
}

/** The projects a user's own chats can use: every project but agents' home projects. */
export function useUserProjects(): ReadonlyArray<EnvironmentProject> {
  return withoutAgentHomeProjects(useProjects(), useAgentHomeProjectKeys());
}
