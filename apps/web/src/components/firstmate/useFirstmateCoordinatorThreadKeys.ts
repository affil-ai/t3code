import { firstmateCoordinatorThreadKeys } from "@t3tools/client-runtime/firstmate/chat-lists";

import { useFirstmateHome } from "~/state/firstmate";

/**
 * The coordinator chat's scoped key, for the sidebar lists to leave out. It
 * is empty when no environment serves Firstmate or none has a coordinator.
 */
export function useFirstmateCoordinatorThreadKeys(): ReadonlySet<string> {
  const home = useFirstmateHome();
  return firstmateCoordinatorThreadKeys(
    home?.environmentId ?? null,
    home?.snapshot.coordinatorThreadId ?? null,
  );
}
