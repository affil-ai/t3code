/**
 * T3 Work client state: the Code/Work mode switch and Work's projects.
 *
 * Work projects are user-created and not tied to a repository. They are a
 * client-side organization layer over server threads: the server still owns
 * every thread and its repository project; this store only records which Work
 * project a thread is filed in, keyed by `scopedThreadKey`. A thread without an
 * entry shows under Chats. Deleting a Work project never deletes threads: its
 * chats move to its parent, or back to Chats.
 *
 * Persisted field names (`folders`, `threadFolderByKey`) predate the
 * "project" naming and are kept so saved data carries over.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { randomUUID } from "./lib/utils";

export type AppMode = "code" | "work";

export interface WorkFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export interface WorkSharedData {
  folders: WorkFolder[];
  threadFolderByKey: Record<string, string>;
}

export interface WorkModeData extends WorkSharedData {
  mode: AppMode;
  collapsedFolderIds: string[];
  /** Scoped project key that new Work chats start in, or null for the first project. */
  defaultProjectKey: string | null;
}

export type WorkModeOperation =
  | {
      type: "createFolder";
      input: { id: string; name: string; parentId: string | null; createdAt: string };
    }
  | { type: "renameFolder"; folderId: string; name: string }
  | { type: "deleteFolder"; folderId: string }
  | { type: "moveFolder"; folderId: string; parentId: string | null }
  | {
      type: "reorderFolder";
      folderId: string;
      targetId: string;
      position: "before" | "after";
    }
  | { type: "fileThreads"; threadKeys: ReadonlyArray<string>; projectId: string | null };

export const WORK_MODE_STORAGE_KEY = "t3work:work-mode:v1";

export const initialWorkModeData: WorkModeData = {
  mode: "code",
  folders: [],
  threadFolderByKey: {},
  collapsedFolderIds: [],
  defaultProjectKey: null,
};

function normalizeFolderName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

function folderExists(data: WorkModeData, folderId: string | null): boolean {
  return folderId === null || data.folders.some((folder) => folder.id === folderId);
}

/** The folder and every folder nested below it. */
export function collectFolderSubtreeIds(
  folders: ReadonlyArray<WorkFolder>,
  folderId: string,
): Set<string> {
  const subtree = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId !== null && subtree.has(folder.parentId) && !subtree.has(folder.id)) {
        subtree.add(folder.id);
        grew = true;
      }
    }
  }
  return subtree;
}

export function createFolder(
  data: WorkModeData,
  input: { id: string; name: string; parentId: string | null; createdAt: string },
): WorkModeData {
  const name = normalizeFolderName(input.name);
  if (!name || !folderExists(data, input.parentId)) return data;
  if (data.folders.some((folder) => folder.id === input.id)) return data;
  return {
    ...data,
    folders: [
      ...data.folders,
      { id: input.id, name, parentId: input.parentId, createdAt: input.createdAt },
    ],
    // Opening the parent shows the folder that was just created.
    collapsedFolderIds: data.collapsedFolderIds.filter((id) => id !== input.parentId),
  };
}

export function renameFolder(data: WorkModeData, folderId: string, name: string): WorkModeData {
  const normalized = normalizeFolderName(name);
  if (!normalized) return data;
  let changed = false;
  const folders = data.folders.map((folder) => {
    if (folder.id !== folderId || folder.name === normalized) return folder;
    changed = true;
    return { ...folder, name: normalized };
  });
  return changed ? { ...data, folders } : data;
}

/** Remove a folder. Its subfolders and threads move to the folder's parent. */
export function deleteFolder(data: WorkModeData, folderId: string): WorkModeData {
  const folder = data.folders.find((entry) => entry.id === folderId);
  if (!folder) return data;
  const threadFolderByKey: Record<string, string> = {};
  for (const [threadKey, threadFolderId] of Object.entries(data.threadFolderByKey)) {
    if (threadFolderId !== folderId) {
      threadFolderByKey[threadKey] = threadFolderId;
    } else if (folder.parentId !== null) {
      threadFolderByKey[threadKey] = folder.parentId;
    }
  }
  return {
    ...data,
    folders: data.folders
      .filter((entry) => entry.id !== folderId)
      .map((entry) =>
        entry.parentId === folderId ? { ...entry, parentId: folder.parentId } : entry,
      ),
    threadFolderByKey,
    collapsedFolderIds: data.collapsedFolderIds.filter((id) => id !== folderId),
  };
}

/** Move a folder under another folder, or to the top level. Refuses to create a cycle. */
export function moveFolder(
  data: WorkModeData,
  folderId: string,
  parentId: string | null,
): WorkModeData {
  const folder = data.folders.find((entry) => entry.id === folderId);
  if (!folder || folder.parentId === parentId || !folderExists(data, parentId)) return data;
  if (parentId !== null && collectFolderSubtreeIds(data.folders, folderId).has(parentId)) {
    return data;
  }
  return {
    ...data,
    folders: data.folders.map((entry) => (entry.id === folderId ? { ...entry, parentId } : entry)),
  };
}

/** File threads in a Work project, or return them to Chats with `null`. */
export function fileThreads(
  data: WorkModeData,
  threadKeys: ReadonlyArray<string>,
  projectId: string | null,
): WorkModeData {
  if (!folderExists(data, projectId) || threadKeys.length === 0) return data;
  if (projectId === null && !threadKeys.some((threadKey) => threadKey in data.threadFolderByKey)) {
    return data;
  }
  const threadFolderByKey = { ...data.threadFolderByKey };
  for (const threadKey of threadKeys) {
    if (projectId === null) {
      delete threadFolderByKey[threadKey];
    } else {
      threadFolderByKey[threadKey] = projectId;
    }
  }
  return { ...data, threadFolderByKey };
}

/**
 * Move a folder next to a sibling, before or after it, taking the sibling's
 * parent. Refuses to move a folder into its own subtree.
 */
export function reorderFolder(
  data: WorkModeData,
  folderId: string,
  targetId: string,
  position: "before" | "after",
): WorkModeData {
  if (folderId === targetId) return data;
  const folder = data.folders.find((entry) => entry.id === folderId);
  const target = data.folders.find((entry) => entry.id === targetId);
  if (!folder || !target) return data;
  if (
    target.parentId !== null &&
    collectFolderSubtreeIds(data.folders, folderId).has(target.parentId)
  ) {
    return data;
  }
  const rest = data.folders.filter((entry) => entry.id !== folderId);
  const targetIndex = rest.findIndex((entry) => entry.id === targetId);
  const insertAt = position === "before" ? targetIndex : targetIndex + 1;
  const moved = { ...folder, parentId: target.parentId };
  const folders = [...rest.slice(0, insertAt), moved, ...rest.slice(insertAt)];
  const unchanged = folders.every((entry, index) => {
    const previous = data.folders[index];
    return (
      previous !== undefined && entry.id === previous.id && entry.parentId === previous.parentId
    );
  });
  return unchanged ? data : { ...data, folders };
}

export function applyWorkModeOperation(
  data: WorkModeData,
  operation: WorkModeOperation,
): WorkModeData {
  switch (operation.type) {
    case "createFolder":
      return createFolder(data, operation.input);
    case "renameFolder":
      return renameFolder(data, operation.folderId, operation.name);
    case "deleteFolder":
      return deleteFolder(data, operation.folderId);
    case "moveFolder":
      return moveFolder(data, operation.folderId, operation.parentId);
    case "reorderFolder":
      return reorderFolder(data, operation.folderId, operation.targetId, operation.position);
    case "fileThreads":
      return fileThreads(data, operation.threadKeys, operation.projectId);
  }
}

export function pickWorkSharedData(
  data: Pick<WorkModeData, "folders" | "threadFolderByKey">,
): WorkSharedData {
  return {
    folders: data.folders,
    threadFolderByKey: data.threadFolderByKey,
  };
}

export function setFolderCollapsed(
  data: WorkModeData,
  folderId: string,
  collapsed: boolean,
): WorkModeData {
  const isCollapsed = data.collapsedFolderIds.includes(folderId);
  if (isCollapsed === collapsed) return data;
  return {
    ...data,
    collapsedFolderIds: collapsed
      ? [...data.collapsedFolderIds, folderId]
      : data.collapsedFolderIds.filter((id) => id !== folderId),
  };
}

/** The Work project a thread is filed in, or null when it shows under Chats. */
export function resolveThreadWorkProjectId(
  data: Pick<WorkModeData, "folders" | "threadFolderByKey">,
  threadKey: string,
): string | null {
  const projectId = data.threadFolderByKey[threadKey];
  if (!projectId) return null;
  return data.folders.some((folder) => folder.id === projectId) ? projectId : null;
}

export interface WorkFolderNode {
  folder: WorkFolder;
  depth: number;
  children: WorkFolderNode[];
}

/** Build the folder tree. Siblings keep the user's order: the order of `folders`. */
export function buildWorkFolderTree(folders: ReadonlyArray<WorkFolder>): WorkFolderNode[] {
  const knownIds = new Set(folders.map((folder) => folder.id));
  const childrenByParent = new Map<string | null, WorkFolder[]>();
  for (const folder of folders) {
    // A folder whose parent is missing is shown at the top level instead of disappearing.
    const parentId =
      folder.parentId !== null && knownIds.has(folder.parentId) ? folder.parentId : null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(folder);
    childrenByParent.set(parentId, siblings);
  }
  const visited = new Set<string>();
  const build = (parentId: string | null, depth: number): WorkFolderNode[] =>
    (childrenByParent.get(parentId) ?? []).flatMap((folder) => {
      if (visited.has(folder.id)) return [];
      visited.add(folder.id);
      return [{ folder, depth, children: build(folder.id, depth + 1) }];
    });
  return build(null, 0);
}

export function sanitizePersistedData(value: unknown): WorkModeData {
  if (!value || typeof value !== "object") return initialWorkModeData;
  const raw = value as Partial<Record<keyof WorkModeData, unknown>>;
  const folders = Array.isArray(raw.folders)
    ? raw.folders.filter(
        (folder): folder is WorkFolder =>
          !!folder &&
          typeof folder === "object" &&
          typeof folder.id === "string" &&
          typeof folder.name === "string" &&
          (folder.parentId === null || typeof folder.parentId === "string") &&
          typeof folder.createdAt === "string",
      )
    : [];
  const threadFolderByKey =
    raw.threadFolderByKey && typeof raw.threadFolderByKey === "object"
      ? Object.fromEntries(
          Object.entries(raw.threadFolderByKey).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
          ),
        )
      : {};
  return {
    mode: raw.mode === "work" ? "work" : "code",
    folders,
    threadFolderByKey,
    collapsedFolderIds: Array.isArray(raw.collapsedFolderIds)
      ? raw.collapsedFolderIds.filter((id): id is string => typeof id === "string")
      : [],
    defaultProjectKey: typeof raw.defaultProjectKey === "string" ? raw.defaultProjectKey : null,
  };
}

/** Sanitize the subset of Work state that is safe to share with a server. */
export function sanitizeWorkSharedData(value: unknown): WorkSharedData {
  const persisted = sanitizePersistedData(value);
  const folderIds = new Set(persisted.folders.map((folder) => folder.id));
  return {
    folders: persisted.folders,
    threadFolderByKey: Object.fromEntries(
      Object.entries(persisted.threadFolderByKey).filter(([, folderId]) => folderIds.has(folderId)),
    ),
  };
}

interface WorkModeStore extends WorkModeData {
  /** Operations are transient and let the sync layer rebase local edits. */
  pendingOperations: WorkModeOperation[];
  /** Work project whose name is being edited inline. Not persisted. */
  editingFolderId: string | null;
  setMode: (mode: AppMode) => void;
  createFolder: (name: string, parentId: string | null) => string;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  moveFolder: (folderId: string, parentId: string | null) => void;
  reorderFolder: (folderId: string, targetId: string, position: "before" | "after") => void;
  fileThreads: (threadKeys: ReadonlyArray<string>, projectId: string | null) => void;
  setFolderCollapsed: (folderId: string, collapsed: boolean) => void;
  setEditingFolderId: (folderId: string | null) => void;
  setDefaultProjectKey: (projectKey: string | null) => void;
  applyServerData: (value: unknown) => void;
  acknowledgePendingOperations: (count: number) => void;
}

const pickData = (state: WorkModeStore): WorkModeData => ({
  mode: state.mode,
  folders: state.folders,
  threadFolderByKey: state.threadFolderByKey,
  collapsedFolderIds: state.collapsedFolderIds,
  defaultProjectKey: state.defaultProjectKey,
});

function workDataChanged(left: WorkModeData, right: WorkModeData): boolean {
  return (
    left.mode !== right.mode ||
    left.folders !== right.folders ||
    left.threadFolderByKey !== right.threadFolderByKey ||
    left.collapsedFolderIds !== right.collapsedFolderIds ||
    left.defaultProjectKey !== right.defaultProjectKey
  );
}

function applyRecordedOperation(
  state: WorkModeStore,
  operation: WorkModeOperation,
): Partial<WorkModeStore> {
  const current = pickData(state);
  const next = applyWorkModeOperation(current, operation);
  if (!workDataChanged(current, next)) return state;
  return {
    ...next,
    pendingOperations: [...state.pendingOperations, operation],
  };
}

export const useWorkModeStore = create<WorkModeStore>()(
  persist(
    (set) => ({
      ...initialWorkModeData,
      pendingOperations: [],
      editingFolderId: null,
      setMode: (mode) => set({ mode }),
      createFolder: (name, parentId) => {
        const id = randomUUID();
        const operation: WorkModeOperation = {
          type: "createFolder",
          input: { id, name, parentId, createdAt: new Date().toISOString() },
        };
        set((state) => applyRecordedOperation(state, operation));
        return id;
      },
      renameFolder: (folderId, name) =>
        set((state) => applyRecordedOperation(state, { type: "renameFolder", folderId, name })),
      deleteFolder: (folderId) =>
        set((state) => applyRecordedOperation(state, { type: "deleteFolder", folderId })),
      moveFolder: (folderId, parentId) =>
        set((state) => applyRecordedOperation(state, { type: "moveFolder", folderId, parentId })),
      reorderFolder: (folderId, targetId, position) =>
        set((state) =>
          applyRecordedOperation(state, { type: "reorderFolder", folderId, targetId, position }),
        ),
      fileThreads: (threadKeys, projectId) =>
        set((state) =>
          applyRecordedOperation(state, {
            type: "fileThreads",
            threadKeys: [...threadKeys],
            projectId,
          }),
        ),
      setFolderCollapsed: (folderId, collapsed) =>
        set((state) => setFolderCollapsed(pickData(state), folderId, collapsed)),
      setEditingFolderId: (editingFolderId) => set({ editingFolderId }),
      setDefaultProjectKey: (defaultProjectKey) => set({ defaultProjectKey }),
      applyServerData: (value) =>
        set((state) => {
          const shared = sanitizeWorkSharedData(value);
          const folderIds = new Set(shared.folders.map((folder) => folder.id));
          const collapsedFolderIds = state.collapsedFolderIds.filter((id) => folderIds.has(id));
          if (
            state.folders === shared.folders &&
            state.threadFolderByKey === shared.threadFolderByKey &&
            state.collapsedFolderIds === collapsedFolderIds
          ) {
            return state;
          }
          return { ...state, ...shared, collapsedFolderIds };
        }),
      acknowledgePendingOperations: (count) =>
        set((state) =>
          count > 0 ? { pendingOperations: state.pendingOperations.slice(count) } : state,
        ),
    }),
    {
      name: WORK_MODE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: pickData,
      merge: (persisted, current) => ({ ...current, ...sanitizePersistedData(persisted) }),
    },
  ),
);

export function useAppMode(): AppMode {
  return useWorkModeStore((state) => state.mode);
}

export function useIsWorkMode(): boolean {
  return useWorkModeStore((state) => state.mode === "work");
}

/** Non-reactive read for event handlers that should not re-subscribe on mode changes. */
export function isWorkModeActive(): boolean {
  return useWorkModeStore.getState().mode === "work";
}
