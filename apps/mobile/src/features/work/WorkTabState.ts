import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useRef, type Dispatch } from "react";

import { agentsEnvironment, useAgentsHome } from "../../state/agents";
import { environmentPresentations } from "../../state/presentation";
import { useWorkspaceEnvironments } from "../../state/workspace";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import {
  NAVIGATION_TAB_ICONS,
  WORKSPACE_TAB_LABELS,
  useEnabledNavigationTabs,
} from "../workspace/navigation-tabs";
import type {
  WorkspaceTab,
  WorkspaceTabsAction,
  WorkspaceTabsState,
} from "../workspace/workspace-tabs-state";
import { visibleWorkspaceTabs, workTabAvailable, workTabSelection } from "./WorkTab.logic";

/** The environment that last served Work this session; see `workTabAvailable`. */
const rememberedWorkEnvironmentAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("work:remembered-environment"),
);

/**
 * The remembered environment is connected and answered `agents.subscribe`
 * with a failure: it now runs a server without agents (a stock server), so the
 * tab must go. A reconnect that has not answered yet is not a failure.
 */
const rememberedWorkUnsupportedAtom = Atom.make((get) => {
  const remembered = get(rememberedWorkEnvironmentAtom);
  if (remembered === null) return false;
  const environmentId = EnvironmentId.make(remembered);
  const presentation = get(environmentPresentations.presentationsAtom).get(environmentId);
  if (presentation?.connection.phase !== "connected") return false;
  return AsyncResult.isFailure(get(agentsEnvironment.live({ environmentId, input: {} })));
}).pipe(Atom.withLabel("work:remembered-environment-unsupported"));

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
  const rememberedUnsupported = useAtomValue(rememberedWorkUnsupportedAtom);
  const environments = useWorkspaceEnvironments();
  return workTabAvailable({
    liveEnvironmentId,
    rememberedEnvironmentId,
    rememberedUnsupported,
    savedEnvironmentIds: environments.map((environment) => String(environment.environmentId)),
  });
}

/** The workspace tabs to draw, in order: Work, when available, then the enabled navigation tabs. */
export function useVisibleWorkspaceTabs() {
  const workAvailable = useWorkTabAvailable();
  const enabled = useEnabledNavigationTabs();
  return useMemo(() => visibleWorkspaceTabs(workAvailable, enabled), [workAvailable, enabled]);
}

/** Labels and icons for every workspace tab, Work included. */
export const WORKSPACE_TAB_TITLES: Readonly<Record<WorkspaceTab, string>> = {
  ...WORKSPACE_TAB_LABELS,
  work: "Work",
};

export const WORKSPACE_TAB_ICONS: Readonly<Record<WorkspaceTab, AppSymbolName>> = {
  ...NAVIGATION_TAB_ICONS,
  work: "person.2",
};

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
