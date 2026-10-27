import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, type Dispatch } from "react";

import { useAgentsHome } from "../../state/agents";
import { useWorkspaceEnvironments } from "../../state/workspace";
import type { WorkspaceTabsAction, WorkspaceTabsState } from "../workspace/workspace-tabs-state";
import { visibleWorkspaceTabs, workTabAvailable, workTabSelection } from "./WorkTab.logic";

/** The environment that last served Work this session; see `workTabAvailable`. */
const rememberedWorkEnvironmentAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("work:remembered-environment"),
);

/**
 * Work needs the agents stream: the screen is built on the agent list, so a
 * server that serves Firstmate alone (an older fork) keeps the tab hidden
 * rather than showing a screen that never loads.
 */
function useLiveWorkEnvironmentId(): string | null {
  return useAgentsHome()?.environmentId ?? null;
}

/** Whether the workspace shows the Work tab. */
export function useWorkTabAvailable(): boolean {
  const liveEnvironmentId = useLiveWorkEnvironmentId();
  const rememberedEnvironmentId = useAtomValue(rememberedWorkEnvironmentAtom);
  const environments = useWorkspaceEnvironments();
  return workTabAvailable({
    liveEnvironmentId,
    rememberedEnvironmentId,
    savedEnvironmentIds: environments.map((environment) => String(environment.environmentId)),
  });
}

/** The workspace tabs to draw, in order. */
export function useVisibleWorkspaceTabs() {
  return visibleWorkspaceTabs(useWorkTabAvailable());
}

/**
 * Keeps the tab selection in step with Work's availability: picks Work the
 * first time it appears in a session the user has not steered yet, and
 * leaves Work for Threads when no server offers it. Mount once, with the
 * workspace tab state.
 */
export function useWorkTabSelection(
  state: WorkspaceTabsState,
  dispatch: Dispatch<WorkspaceTabsAction>,
) {
  const liveEnvironmentId = useLiveWorkEnvironmentId();
  const remember = useAtomSet(rememberedWorkEnvironmentAtom);
  const available = useWorkTabAvailable();
  const defaultSettled = useRef(false);
  useEffect(() => {
    if (liveEnvironmentId !== null) remember(liveEnvironmentId);
  }, [liveEnvironmentId, remember]);
  useEffect(() => {
    const next = workTabSelection({
      available,
      selectedTab: state.selectedTab,
      selectionRevision: state.selectionRevision,
      defaultSettled: defaultSettled.current,
    });
    defaultSettled.current = next.defaultSettled;
    if (next.tab !== null) dispatch({ type: "select", tab: next.tab });
  }, [available, state.selectedTab, state.selectionRevision, dispatch]);
}
