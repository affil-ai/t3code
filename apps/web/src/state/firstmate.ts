import { useAtomValue } from "@effect/atom-react";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  FIRSTMATE_WS_METHODS,
  type EnvironmentId,
  type FirstmateSnapshot,
  type FirstmateTaskId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";

/** Fork-only Firstmate atoms, kept out of the upstream environment state. */
function createFirstmateEnvironmentAtoms(runtime: typeof connectionAtomRuntime) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    setTaskPriority: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:firstmate:set-task-priority",
      tag: FIRSTMATE_WS_METHODS.firstmateSetTaskPriority,
      scheduler,
      concurrency,
    }),
    live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:firstmate:live",
      tag: FIRSTMATE_WS_METHODS.firstmateSubscribe,
    }),
    getTask: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:firstmate:get-task",
      tag: FIRSTMATE_WS_METHODS.firstmateGetTask,
    }),
    setCoordinator: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:firstmate:set-coordinator",
      tag: FIRSTMATE_WS_METHODS.firstmateSetCoordinator,
      scheduler,
      concurrency,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:firstmate:start",
      tag: FIRSTMATE_WS_METHODS.firstmateStart,
      scheduler,
      concurrency,
    }),
    setAppearance: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:firstmate:set-appearance",
      tag: FIRSTMATE_WS_METHODS.firstmateSetAppearance,
      scheduler,
      concurrency,
    }),
  };
}

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

export interface FirstmateHome {
  readonly environmentId: EnvironmentId;
  readonly snapshot: FirstmateSnapshot;
}

/**
 * The first connected environment, in catalog order, whose server answers
 * `firstmate.subscribe`. An environment that is still answering holds the
 * place, so a slow fork server is not skipped for a later one. Servers without
 * Firstmate fail the subscription and are passed over; null means none has it.
 */
const firstmateHomeAtom = Atom.make((get): FirstmateHome | null => {
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (presentation.connection.phase !== "connected" || presentation.serverConfig === null) {
      continue;
    }
    const result = get(firstmateEnvironment.live({ environmentId, input: {} }));
    if (AsyncResult.isSuccess(result)) return { environmentId, snapshot: result.value };
    if (AsyncResult.isFailure(result)) continue;
    return null;
  }
  return null;
}).pipe(Atom.withLabel("firstmate:home"));

export function useFirstmateHome(): FirstmateHome | null {
  return useAtomValue(firstmateHomeAtom);
}

/** The current Firstmate home, read once outside React, as event handlers do. */
export function readFirstmateHome(): FirstmateHome | null {
  return appAtomRegistry.get(firstmateHomeAtom);
}
