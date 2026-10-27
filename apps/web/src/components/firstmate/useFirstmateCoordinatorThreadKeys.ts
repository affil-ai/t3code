import { firstmateCoordinatorThreadKeys } from "@t3tools/client-runtime/firstmate/chat-lists";

import { useFirstmateHome } from "~/state/firstmate";

/**
 * The coordinator chat's scoped key, for the sidebar lists to leave out. It
 * is empty when no environment serves Firstmate or none has a coordinator.
 */
export function useFirstmateCoordinatorThreadKeys(): ReadonlySet<string> {
  const home = useFirstmateHome();
  // Read the two ids first so the React Compiler keys the set on them, not on
  // the snapshot: a new set on every board update re-renders the lists.
  const environmentId = home?.environmentId ?? null;
  const coordinatorThreadId = home?.snapshot.coordinatorThreadId ?? null;
  return firstmateCoordinatorThreadKeys(environmentId, coordinatorThreadId);
}
