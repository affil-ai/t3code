import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useMemo } from "react";

import { readAgentsHome, useAgentsHome } from "~/state/agents";

/**
 * Every agent's coordinator chat, Firstmate's included, as scoped keys for
 * the Work sidebar list to leave out: those chats have their own
 * rows in Agents mode and under Search. Search still finds them.
 */
export function useAgentCoordinatorThreadKeys(): ReadonlySet<string> {
  const home = useAgentsHome();
  return useMemo(() => {
    if (home === null) return new Set<string>();
    return new Set(
      home.agents.flatMap((agent) =>
        agent.coordinatorThreadId === null
          ? []
          : [scopedThreadKey(scopeThreadRef(home.environmentId, agent.coordinatorThreadId))],
      ),
    );
  }, [home]);
}

/** Every agent's home project key, for the Work sidebar's new chat to skip. */
export function readAgentHomeProjectKeys(): ReadonlySet<string> {
  const home = readAgentsHome();
  if (home === null) return new Set<string>();
  return new Set(
    home.agents.flatMap((agent) =>
      agent.homeProjectId === null
        ? []
        : [scopedProjectKey(scopeProjectRef(home.environmentId, agent.homeProjectId))],
    ),
  );
}
