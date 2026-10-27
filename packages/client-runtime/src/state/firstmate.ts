/**
 * Fork-only Firstmate atoms: the board stream, task detail, and mutations,
 * plus the "home" selection every client uses to find the environment that
 * serves Firstmate. Each client binds these to its own runtime and keeps its
 * React hooks.
 *
 * @module state/firstmate
 */
import {
  FIRSTMATE_WS_METHODS,
  type EnvironmentId,
  type FirstmateSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createFirstmateEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
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

/** What the home selection needs from a client's environment presentations. */
export type EnvironmentPresentationsAtom = Atom.Atom<
  ReadonlyMap<EnvironmentId, { readonly connection: { readonly phase: string } }>
>;

/**
 * The first connected environment, in catalog order, whose stream succeeds.
 * An environment still answering holds the place, so a slow fork server is
 * not skipped for a later one; servers that fail (a stock server without the
 * fork's RPCs) are passed over. Null means none serves it yet.
 *
 * Every connected host's stream opens together, so an unsupported host does
 * not delay the next one.
 */
export function createHomeEnvironmentAtom<A>(input: {
  readonly label: string;
  readonly presentationsAtom: EnvironmentPresentationsAtom;
  readonly resultAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>;
}): Atom.Atom<{ readonly environmentId: EnvironmentId; readonly value: A } | null> {
  return Atom.make((get) => {
    const candidates = [...get(input.presentationsAtom)]
      .filter(([, presentation]) => presentation.connection.phase === "connected")
      .map(([environmentId]) => ({ environmentId, result: get(input.resultAtom(environmentId)) }));
    for (const { environmentId, result } of candidates) {
      if (AsyncResult.isSuccess(result)) return { environmentId, value: result.value };
      if (AsyncResult.isFailure(result)) continue;
      return null;
    }
    return null;
  }).pipe(Atom.withLabel(input.label));
}

export interface FirstmateHome {
  readonly environmentId: EnvironmentId;
  readonly snapshot: FirstmateSnapshot;
}

/** The environment that serves Firstmate, with its live board. */
export function createFirstmateHomeAtom(input: {
  readonly presentationsAtom: EnvironmentPresentationsAtom;
  readonly live: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: {};
  }) => Atom.Atom<AsyncResult.AsyncResult<FirstmateSnapshot, unknown>>;
}): Atom.Atom<FirstmateHome | null> {
  const home = createHomeEnvironmentAtom({
    label: "firstmate:home-environment",
    presentationsAtom: input.presentationsAtom,
    resultAtom: (environmentId) => input.live({ environmentId, input: {} }),
  });
  return Atom.make((get): FirstmateHome | null => {
    const selected = get(home);
    return selected === null
      ? null
      : { environmentId: selected.environmentId, snapshot: selected.value };
  }).pipe(Atom.withLabel("firstmate:home"));
}
