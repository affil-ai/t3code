import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { OFFICE_WS_METHODS, type EnvironmentId, type OfficeThread } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentPresentations } from "./presentation";

const live = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:office:live",
  tag: OFFICE_WS_METHODS.subscribe,
});
export interface ScopedOfficeThread extends OfficeThread {
  readonly environmentId: EnvironmentId;
}
const officeThreadsAtom = Atom.make((get): readonly ScopedOfficeThread[] => {
  const threads: ScopedOfficeThread[] = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (presentation.connection.phase !== "connected" || presentation.serverConfig === null)
      continue;
    const result = get(live({ environmentId, input: {} }));
    if (AsyncResult.isSuccess(result)) {
      threads.push(...result.value.threads.map((thread) => ({ ...thread, environmentId })));
    }
  }
  return threads;
}).pipe(Atom.withLabel("office:threads"));
export function useOfficeThreads() {
  return useAtomValue(officeThreadsAtom);
}
