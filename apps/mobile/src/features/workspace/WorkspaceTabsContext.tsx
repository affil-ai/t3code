import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { createContext, use, useState, type Dispatch, type ReactNode } from "react";

import { mobilePreferencesAtom } from "../../state/preferences";
import {
  navigationCustomizationAvailable,
  resolveHiddenNavigationTabs,
  resolveSelectedNavigationTab,
} from "./navigation-tab-order";
import {
  initialWorkspaceTabsState,
  resolveWorkspaceTabOrder,
  workspaceTabsReducer,
  type WorkspaceSearchTab,
  type WorkspaceTab,
  type WorkspaceTabsAction,
  type WorkspaceTabsState,
} from "./workspace-tabs-state";
import { useWorkTabSelection } from "../work/WorkTabState"; // fork: work
import { useShowcaseWorkspaceTab } from "../showcase/showcaseWorkspaceTab"; // fork: work

export const WorkspaceTabsContext = createContext<{
  readonly state: WorkspaceTabsState;
  readonly dispatch: Dispatch<WorkspaceTabsAction>;
  readonly isTabActive: (tab: WorkspaceTab) => boolean;
  readonly bottomClearance: number;
  readonly settingsOpen: boolean;
  readonly getScrollOffset: (tab: WorkspaceSearchTab) => number;
  readonly recordScrollOffset: (tab: WorkspaceSearchTab, offset: number) => void;
} | null>(null);

export function useWorkspaceTabs() {
  return use(WorkspaceTabsContext);
}

type MobilePreferencesResult = Atom.Type<typeof mobilePreferencesAtom>;

/** Moves the selection off a tab the user has hidden or that no longer exists. */
function resolveWorkspaceTabsSelection(
  state: WorkspaceTabsState,
  preferences: MobilePreferencesResult,
): WorkspaceTabsState {
  const saved = AsyncResult.isSuccess(preferences) ? preferences.value : undefined;
  const order = resolveWorkspaceTabOrder(saved?.navigationTabOrder);
  const hidden = navigationCustomizationAvailable()
    ? resolveHiddenNavigationTabs(saved?.hiddenNavigationTabs)
    : [];
  // fork: work: Work is not in the navigation order; useWorkTabSelection leaves it when it goes.
  const selected =
    state.selectedTab === "work"
      ? "work"
      : resolveSelectedNavigationTab(order, hidden, state.selectedTab);
  return selected && selected !== state.selectedTab
    ? workspaceTabsReducer(state, { type: "select", tab: selected })
    : state;
}

// One model per provider. Handlers on frozen screens keep stale closures, so
// they read the current selection from the registry at call time.
function createWorkspaceTabsModel() {
  const stored = Atom.make(initialWorkspaceTabsState());
  const scrollOffsets: Record<WorkspaceSearchTab, number> = {
    threads: 0,
    pullRequests: 0,
    usage: 0,
    settings: 0,
    work: 0, // fork: work
  };
  return {
    stored,
    resolved: Atom.make((get) =>
      resolveWorkspaceTabsSelection(get(stored), get(mobilePreferencesAtom)),
    ),
    getScrollOffset: (tab: WorkspaceSearchTab) => scrollOffsets[tab],
    recordScrollOffset: (tab: WorkspaceSearchTab, offset: number) => {
      scrollOffsets[tab] = offset;
    },
  };
}

export function WorkspaceTabsProvider(props: {
  readonly children: ReactNode;
  readonly settingsOpen?: boolean;
}) {
  const registry = use(RegistryContext);
  const [model] = useState(createWorkspaceTabsModel);
  const state = useAtomValue(model.resolved);
  const dispatch = (action: WorkspaceTabsAction) =>
    registry.set(model.stored, workspaceTabsReducer(registry.get(model.resolved), action));
  useWorkTabSelection(state, dispatch); // fork: work
  useShowcaseWorkspaceTab(state.selectedTab, dispatch); // fork: work
  const context = {
    state,
    dispatch,
    isTabActive: (tab: WorkspaceTab) => registry.get(model.resolved).selectedTab === tab,
    bottomClearance: 0,
    settingsOpen: props.settingsOpen ?? false,
    getScrollOffset: model.getScrollOffset,
    recordScrollOffset: model.recordScrollOffset,
  };
  return <WorkspaceTabsContext value={context}>{props.children}</WorkspaceTabsContext>;
}
