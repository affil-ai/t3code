import { resolveSelectedNavigationTab } from "./navigation-tab-order";
import { useNavigationTabOrder, useHiddenNavigationTabs } from "./navigation-tabs";
import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  initialWorkspaceTabsState,
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

export function WorkspaceTabsProvider(props: {
  readonly children: ReactNode;
  readonly settingsOpen?: boolean;
}) {
  const [state, dispatch] = useReducer(workspaceTabsReducer, undefined, initialWorkspaceTabsState);
  useWorkTabSelection(state, dispatch); // fork: work
  useShowcaseWorkspaceTab(state.selectedTab, dispatch); // fork: work
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  // fork: work: Work is not in the navigation order; useWorkTabSelection leaves it when it goes.
  const selected =
    state.selectedTab === "work"
      ? "work"
      : resolveSelectedNavigationTab(order, hidden, state.selectedTab);
  if (selected && selected !== state.selectedTab) dispatch({ type: "select", tab: selected });
  const activeTab = useRef(state.selectedTab);
  useLayoutEffect(() => {
    activeTab.current = state.selectedTab;
  }, [state.selectedTab]);
  const isTabActive = useCallback((tab: WorkspaceTab) => activeTab.current === tab, []);
  // fork: work
  const scrollOffsets = useRef({ threads: 0, pullRequests: 0, usage: 0, settings: 0, work: 0 });
  const getScrollOffset = useCallback((tab: WorkspaceSearchTab) => scrollOffsets.current[tab], []);
  const recordScrollOffset = useCallback((tab: WorkspaceSearchTab, offset: number) => {
    scrollOffsets.current[tab] = offset;
  }, []);
  const context = useMemo(
    () => ({
      state,
      dispatch,
      isTabActive,
      bottomClearance: 0,
      settingsOpen: props.settingsOpen ?? false,
      getScrollOffset,
      recordScrollOffset,
    }),
    [state, isTabActive, getScrollOffset, recordScrollOffset, props.settingsOpen],
  );
  return <WorkspaceTabsContext value={context}>{props.children}</WorkspaceTabsContext>;
}
