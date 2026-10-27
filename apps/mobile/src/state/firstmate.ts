/**
 * Fork-only Firstmate state for the Work screens: the board stream, task
 * detail, and Firstmate's mutations, bound to this app's runtime. The atoms
 * and the home selection are shared with web through client-runtime.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  createFirstmateEnvironmentAtoms,
  createFirstmateHomeAtom,
  type FirstmateHome,
} from "@t3tools/client-runtime/state/firstmate";
import type { EnvironmentId, FirstmateTaskId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { scopedProjectKey } from "../lib/scopedEntities";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export type { FirstmateHome };

export const firstmateEnvironment = createFirstmateEnvironmentAtoms(connectionAtomRuntime);

const firstmateHomeAtom = createFirstmateHomeAtom({
  presentationsAtom: environmentPresentations.presentationsAtom,
  live: firstmateEnvironment.live,
});

/** The first connected environment whose server serves Firstmate, with its board. */
export function useFirstmateHome(): FirstmateHome | null {
  return useAtomValue(firstmateHomeAtom);
}

/**
 * Firstmate's home project as a scoped key, or null. Selected on its own so a
 * board update does not re-render the lists that only skip this project.
 */
export function useFirstmateHomeProjectKey(): string | null {
  return useAtomValue(firstmateHomeAtom, (home) =>
    home?.snapshot.homeProjectId == null
      ? null
      : scopedProjectKey(home.environmentId, home.snapshot.homeProjectId),
  );
}

/**
 * Any agent's task with its event history. Servers before this fork version
 * resolve `firstmate.getTask` on Firstmate's board only, so a custom agent's
 * task can fail with "Task was not found"; callers hide history on error.
 */
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

/**
 * Firstmate's mutations and whether this connection may run each one. Each
 * command resolves to an `AtomCommandResult`; failures are only logged, so
 * callers show their own error (see `Dialog.alert`).
 */
export function useFirstmateCommands(environmentId: EnvironmentId | null) {
  return {
    setTaskPriority: useAtomCommand(firstmateEnvironment.setTaskPriority),
    setCoordinator: useAtomCommand(firstmateEnvironment.setCoordinator),
    start: useAtomCommand(firstmateEnvironment.start),
    setAppearance: useAtomCommand(firstmateEnvironment.setAppearance),
    can: {
      setTaskPriority: useAtomValue(
        firstmateEnvironment.setTaskPriority.permissionAtom(environmentId),
      ),
      setCoordinator: useAtomValue(
        firstmateEnvironment.setCoordinator.permissionAtom(environmentId),
      ),
      start: useAtomValue(firstmateEnvironment.start.permissionAtom(environmentId)),
      setAppearance: useAtomValue(firstmateEnvironment.setAppearance.permissionAtom(environmentId)),
    },
  };
}
