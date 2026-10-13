/**
 * The coordinator chat's only sidebar entry is the Firstmate row under
 * Search, so the sidebar's chat lists leave it out. Search still finds it.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

export const NO_FIRSTMATE_COORDINATOR_KEYS: ReadonlySet<string> = new Set();

/** The scoped key of the coordinator chat, as a set the lists can filter by. */
export function firstmateCoordinatorThreadKeys(
  environmentId: EnvironmentId | null,
  coordinatorThreadId: ThreadId | null,
): ReadonlySet<string> {
  if (environmentId === null || coordinatorThreadId === null) return NO_FIRSTMATE_COORDINATOR_KEYS;
  return new Set([scopedThreadKey(scopeThreadRef(environmentId, coordinatorThreadId))]);
}
