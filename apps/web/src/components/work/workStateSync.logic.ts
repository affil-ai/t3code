import {
  applyWorkModeOperation,
  pickWorkSharedData,
  sanitizeWorkSharedData,
  type WorkModeData,
  type WorkModeOperation,
  type WorkSharedData,
} from "../../workModeStore";

export interface WorkStateResponse {
  readonly format: "t3work-state/1";
  readonly version: number;
  readonly data: unknown | null;
}

export type WorkStateMigrationDecision = "upload-local" | "apply-server";

export function hasSharedWorkData(
  data: Pick<WorkSharedData, "folders" | "threadFolderByKey">,
): boolean {
  return data.folders.length > 0 || Object.keys(data.threadFolderByKey).length > 0;
}

/** Apply only server-owned fields, retaining this device's local Work settings. */
export function applyServerSnapshot(local: WorkModeData, serverValue: unknown): WorkModeData {
  const shared = sanitizeWorkSharedData(serverValue);
  const folderIds = new Set(shared.folders.map((folder) => folder.id));
  return {
    ...local,
    ...shared,
    collapsedFolderIds: local.collapsedFolderIds.filter((id) => folderIds.has(id)),
  };
}

/** Reapply the exact local reducer calls after a conflicting server snapshot. */
export function replayWorkOperations(
  base: WorkModeData,
  operations: ReadonlyArray<WorkModeOperation>,
): WorkModeData {
  return operations.reduce(applyWorkModeOperation, base);
}

export function rebaseWorkState(
  local: WorkModeData,
  serverValue: unknown,
  operations: ReadonlyArray<WorkModeOperation>,
): WorkModeData {
  return replayWorkOperations(applyServerSnapshot(local, serverValue), operations);
}

export interface WorkStateMigrationInput {
  readonly serverVersion: number;
  readonly serverData: unknown | null;
  readonly localData: WorkSharedData;
  readonly hasSynced: boolean;
}

/**
 * The first empty server accepts existing local data. Once a target has
 * server-owned data, a never-seen client takes it, except for an empty server
 * and a client that already has folders. Later conflicts are handled by the
 * operation replay path rather than this one-time migration decision.
 */
export function decideWorkStateMigration(
  input: WorkStateMigrationInput,
): WorkStateMigrationDecision {
  const localHasData = hasSharedWorkData(input.localData);
  if (input.serverVersion === 0 && input.serverData === null) {
    return localHasData ? "upload-local" : "apply-server";
  }

  if (!input.hasSynced) {
    const server = sanitizeWorkSharedData(input.serverData);
    if (input.localData.folders.length > 0 && server.folders.length === 0) {
      return "upload-local";
    }
  }

  return "apply-server";
}

export function sharedDataFromWorkState(data: WorkModeData): WorkSharedData {
  return pickWorkSharedData(data);
}
