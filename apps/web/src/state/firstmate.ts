import { useAtomValue } from "@effect/atom-react";
import {
  createFirstmateEnvironmentAtoms,
  createFirstmateHomeAtom,
  type FirstmateHome,
} from "@t3tools/client-runtime/state/firstmate";
import type { EnvironmentId, FirstmateTaskId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";

export type { FirstmateHome };

/** Fork-only Firstmate atoms, kept out of the upstream environment state. */
export const firstmateEnvironment = createFirstmateEnvironmentAtoms(connectionAtomRuntime);

export function useFirstmateSnapshot(environmentId: EnvironmentId | null) {
  return useEnvironmentQuery(
    environmentId === null ? null : firstmateEnvironment.live({ environmentId, input: {} }),
  );
}

export function useFirstmateTask(
  environmentId: EnvironmentId | null,
  taskId: FirstmateTaskId | null,
) {
  return useEnvironmentQuery(
    environmentId === null || taskId === null
      ? null
      : firstmateEnvironment.getTask({ environmentId, input: { taskId } }),
  );
}

/** The first connected environment that serves Firstmate; see `createHomeEnvironmentAtom`. */
const firstmateHomeAtom = createFirstmateHomeAtom({
  presentationsAtom: environmentPresentations.presentationsAtom,
  live: firstmateEnvironment.live,
});

export function useFirstmateHome(): FirstmateHome | null {
  return useAtomValue(firstmateHomeAtom);
}

/** The current Firstmate home, read once outside React, as event handlers do. */
export function readFirstmateHome(): FirstmateHome | null {
  return appAtomRegistry.get(firstmateHomeAtom);
}
