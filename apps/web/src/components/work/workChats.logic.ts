/**
 * Work mode's sidebar: user-created projects and the Chats list of threads
 * that are in none of them. Grouping, drag payloads, and the thread context
 * menu entries that move threads between them.
 */
import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import { sortThreads } from "../../lib/threadSort";
import type { SidebarThreadSummary } from "../../types";
import {
  buildWorkFolderTree,
  isWorkModeActive,
  resolveThreadWorkProjectId,
  useWorkModeStore,
  type WorkFolderNode,
  type WorkModeData,
} from "../../workModeStore";

// Upstream dropped these Sidebar.logic helpers; Work mode still files forks
// under their parent and keeps subagent threads out of the Chats list.
export function getSidebarForkParentThreadId(
  thread: Pick<SidebarThreadSummary, "forkedFrom" | "lineage">,
) {
  if (thread.lineage.relationshipToParent !== "fork") {
    return null;
  }
  return thread.forkedFrom?.type === "run"
    ? thread.forkedFrom.threadId
    : thread.lineage.parentThreadId;
}

function isSidebarSubagentThread(thread: Pick<SidebarThreadSummary, "lineage">): boolean {
  return thread.lineage.relationshipToParent === "subagent";
}

/**
 * The repository project a new Work chat runs in, without asking: the open
 * chat's, then the saved default, then the most recently used one. Work
 * projects are not repositories, so the choice only decides where the agent runs.
 */
export function resolveWorkChatRepositoryKey(input: {
  /** Repository project key of the chat on screen, when there is one. */
  activeProjectKey: string | null;
  defaultProjectKey: string | null;
  /** Repository project keys that still exist. */
  projectKeys: ReadonlySet<string>;
  /** Unarchived threads, for the most recently used project. */
  threads: ReadonlyArray<
    Pick<SidebarThreadSummary, "environmentId" | "projectId" | "updatedAt" | "latestUserMessageAt">
  >;
  scopedProjectKey: (environmentId: string, projectId: string) => string;
  /** Projects a new chat never runs in, such as Firstmate's home. */
  excludedProjectKeys?: ReadonlySet<string>;
}): string | null {
  const { activeProjectKey, defaultProjectKey } = input;
  const excluded = input.excludedProjectKeys ?? new Set<string>();
  const projectKeys = new Set([...input.projectKeys].filter((key) => !excluded.has(key)));
  if (activeProjectKey !== null && projectKeys.has(activeProjectKey)) return activeProjectKey;
  if (defaultProjectKey !== null && projectKeys.has(defaultProjectKey)) return defaultProjectKey;
  let best: { key: string; at: number } | null = null;
  for (const thread of input.threads) {
    const key = input.scopedProjectKey(thread.environmentId, thread.projectId);
    if (!projectKeys.has(key)) continue;
    const at = Date.parse(thread.latestUserMessageAt ?? thread.updatedAt) || 0;
    if (best === null || at > best.at) best = { key, at };
  }
  if (best !== null) return best.key;
  return projectKeys.values().next().value ?? null;
}

export const WORK_THREAD_DRAG_TYPE = "application/x-t3work-threads";
export const WORK_PROJECT_DRAG_TYPE = "application/x-t3work-project";

export interface WorkThreadGroups {
  /** Pinned threads, most recently pinned first. They leave their project or Chats. */
  pinned: SidebarThreadSummary[];
  byProjectId: ReadonlyMap<string, SidebarThreadSummary[]>;
  /** Threads in no Work project. */
  chats: SidebarThreadSummary[];
}

/** Unarchived threads grouped by Work project, with the rest under Chats. */
export function groupWorkThreads(
  threads: ReadonlyArray<SidebarThreadSummary>,
  data: Pick<WorkModeData, "folders" | "threadFolderByKey">,
  sortOrder: SidebarThreadSortOrder,
  pinnedThreadKeys: ReadonlyArray<string> = [],
  /** Threads with their own sidebar entry, such as the Firstmate coordinator. */
  hiddenThreadKeys: ReadonlySet<string> = new Set(),
): WorkThreadGroups {
  const pinRank = new Map(pinnedThreadKeys.map((key, index) => [key, index] as const));
  const pinned: SidebarThreadSummary[] = [];
  const byProjectId = new Map<string, SidebarThreadSummary[]>();
  const chats: SidebarThreadSummary[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    // Work's sidebar is a user-facing inbox, not the lineage navigator. Forks
    // are chats the user started, so they stay in it; subagents and other
    // agent-created children stay reachable from the thread's Lineage section.
    if (
      thread.lineage !== undefined &&
      getSidebarForkParentThreadId(thread) === null &&
      (thread.lineage.parentThreadId !== null || isSidebarSubagentThread(thread))
    ) {
      continue;
    }
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (hiddenThreadKeys.has(threadKey)) continue;
    if (pinRank.has(threadKey)) {
      pinned.push(thread);
      continue;
    }
    const projectId = resolveThreadWorkProjectId(data, threadKey);
    if (projectId === null) {
      chats.push(thread);
    } else {
      const list = byProjectId.get(projectId) ?? [];
      list.push(thread);
      byProjectId.set(projectId, list);
    }
  }
  for (const [projectId, list] of byProjectId) {
    byProjectId.set(projectId, sortThreads(list, sortOrder));
  }
  const pinRankOf = (thread: SidebarThreadSummary) =>
    pinRank.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))) ?? 0;
  pinned.sort((left, right) => pinRankOf(left) - pinRankOf(right));
  return { pinned, byProjectId, chats: sortThreads(chats, sortOrder) };
}

export function flattenFolderTree(nodes: ReadonlyArray<WorkFolderNode>): WorkFolderNode[] {
  return nodes.flatMap((node) => [node, ...flattenFolderTree(node.children)]);
}

const MENU_NEW_PROJECT = "work:new-project";
const MENU_REMOVE = "work:remove-from-project";
const MENU_PROJECT_PREFIX = "work:project:";

/** Context menu entries for filing threads in Work projects. */
export function buildWorkThreadMenuItems(
  data: Pick<WorkModeData, "folders" | "threadFolderByKey">,
  threadKeys: ReadonlyArray<string>,
): ContextMenuItem<string>[] {
  if (threadKeys.length === 0) return [];
  const projectIds = threadKeys.map((threadKey) => resolveThreadWorkProjectId(data, threadKey));
  const sharedProjectId = projectIds.every((projectId) => projectId === projectIds[0])
    ? projectIds[0]
    : undefined;
  const projectItems: ContextMenuItem<string>[] = flattenFolderTree(
    buildWorkFolderTree(data.folders),
  )
    .filter((node) => node.folder.id !== sharedProjectId)
    .map((node) => ({
      id: `${MENU_PROJECT_PREFIX}${node.folder.id}`,
      label: `${"   ".repeat(node.depth)}${node.folder.name}`,
    }));

  const items: ContextMenuItem<string>[] = [
    projectItems.length > 0
      ? {
          id: "work:project-submenu",
          label: "Move to project",
          children: [
            ...projectItems,
            { id: MENU_NEW_PROJECT, label: "New project", separatorBefore: true },
          ],
        }
      : { id: MENU_NEW_PROJECT, label: "Move to new project" },
  ];
  if (projectIds.some((projectId) => projectId !== null)) {
    items.push({ id: MENU_REMOVE, label: "Remove from project" });
  }
  return items;
}

/** `buildWorkThreadMenuItems` against the live store, or nothing outside Work mode. */
export function buildWorkThreadMenuItemsForKeys(
  threadKeys: ReadonlyArray<string>,
): ContextMenuItem<string>[] {
  if (!isWorkModeActive()) return [];
  return buildWorkThreadMenuItems(useWorkModeStore.getState(), threadKeys);
}

/** Apply a Work menu entry. Returns false for ids that are not Work entries. */
export function applyWorkThreadMenuAction(
  clicked: string,
  threadKeys: ReadonlyArray<string>,
): boolean {
  const store = useWorkModeStore.getState();
  if (clicked === MENU_REMOVE) {
    store.fileThreads(threadKeys, null);
    return true;
  }
  if (clicked === MENU_NEW_PROJECT) {
    const projectId = store.createFolder("New project", null);
    store.fileThreads(threadKeys, projectId);
    store.setEditingFolderId(projectId);
    return true;
  }
  if (clicked.startsWith(MENU_PROJECT_PREFIX)) {
    store.fileThreads(threadKeys, clicked.slice(MENU_PROJECT_PREFIX.length));
    return true;
  }
  return false;
}

export function isWorkProjectDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(WORK_PROJECT_DRAG_TYPE);
}

/** Drop before a row when the pointer is in its top half, after it otherwise. */
export function resolveDropPosition(clientY: number, rect: { top: number; height: number }) {
  return clientY < rect.top + rect.height / 2 ? ("before" as const) : ("after" as const);
}

export function isWorkThreadDrag(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(WORK_THREAD_DRAG_TYPE);
}

export function writeWorkThreadDrag(dataTransfer: DataTransfer, threadKeys: string[]): void {
  dataTransfer.effectAllowed = "move";
  dataTransfer.setData(WORK_THREAD_DRAG_TYPE, JSON.stringify(threadKeys));
}

export function readWorkThreadDrag(dataTransfer: DataTransfer): string[] | null {
  const raw = dataTransfer.getData(WORK_THREAD_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const threadKeys = parsed.filter((key): key is string => typeof key === "string");
    return threadKeys.length > 0 ? threadKeys : null;
  } catch {
    return null;
  }
}
