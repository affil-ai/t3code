import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  isFirstmateAgent,
  orderAgents,
  resolveSelectedAgent,
  sanitizeSelectedAgentData,
} from "@t3tools/client-runtime/firstmate/agents";
import { AsyncResult } from "effect/reactivity";

import { useAgentsHome } from "../../state/agents";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/**
 * Which agent the Work tab shows on this device, with every agent in the
 * user's tab order. The choice and order are kept in the device's
 * preferences (`selectedAgent`), like web keeps them per browser; an
 * archived or missing choice falls back to Firstmate.
 */
export function useSelectedAgent() {
  const home = useAgentsHome();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const saved = sanitizeSelectedAgentData(
    AsyncResult.isSuccess(preferences) ? preferences.value.selectedAgent : undefined,
  );
  const agents = orderAgents(home?.agents ?? [], saved.agentOrder);
  const selectedAgent =
    home === null
      ? null
      : resolveSelectedAgent(home.agents, saved.selectedAgentId, saved.preferCustomAgent);

  // Transforms read the latest optimistic value, so quick taps don't drop a write.
  const selectAgent = (agentId: string | null) =>
    savePreferences({
      transform: (current) => ({
        selectedAgent: {
          ...sanitizeSelectedAgentData(current.selectedAgent),
          selectedAgentId: agentId,
        },
      }),
    });
  const setAgentOrder = (agentOrder: ReadonlyArray<string>) =>
    savePreferences({
      transform: (current) => ({
        selectedAgent: {
          ...sanitizeSelectedAgentData(current.selectedAgent),
          agentOrder: [...agentOrder],
        },
      }),
    });

  return {
    /** Null until a connected environment answers `agents.subscribe`. */
    environmentId: home?.environmentId ?? null,
    agents,
    selectedAgent,
    isFirstmate: isFirstmateAgent(selectedAgent),
    selectAgent,
    setAgentOrder,
  } as const;
}
