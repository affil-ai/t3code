import { useMemo } from "react";

import { useFirstmateHome } from "~/state/firstmate";
import { firstmateCoordinatorThreadKeys } from "./firstmateChatLists.logic";

/**
 * The coordinator chat's scoped key, for the sidebar lists to leave out. It
 * is empty when no environment serves Firstmate or none has a coordinator.
 */
export function useFirstmateCoordinatorThreadKeys(): ReadonlySet<string> {
  const home = useFirstmateHome();
  const environmentId = home?.environmentId ?? null;
  const coordinatorThreadId = home?.snapshot.coordinatorThreadId ?? null;
  return useMemo(
    () => firstmateCoordinatorThreadKeys(environmentId, coordinatorThreadId),
    [environmentId, coordinatorThreadId],
  );
}
