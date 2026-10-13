/**
 * The coordinator chat's only sidebar entry is the Firstmate row under
 * Search, so the sidebar's chat lists leave it out. Search still finds it.
 * Its home project runs only the coordinator, so new Work chats skip it.
 */
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";

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
