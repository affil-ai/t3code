import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { PullRequestToolbar } from "../pull-requests/PullRequestToolbar.android";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader"; // fork: work
import { WorkScreen } from "../work/WorkScreen"; // fork: work
import { useWorkTabAvailable } from "../work/WorkTabState"; // fork: work
import { visibleWorkspaceTabs } from "../work/WorkTab.logic"; // fork: work
import { useSelectWorkspaceDetail } from "./useSelectWorkspaceDetail"; // fork: work

export function AndroidWorkspaceSidebar(props: {
  readonly children: ReactNode;
  readonly onRequestVisibility: () => void;
  readonly selectedPullRequestKey: string | null;
}) {
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  const context = useMemo(() => ({ ...workspace, bottomClearance: 16 }), [workspace]);
  // fork: work: Work leads the retained panes while a server runs agents.
  const workAvailable = useWorkTabAvailable();
  const tabs = useMemo(
    () => visibleWorkspaceTabs(workAvailable, NAVIGATION_TAB_ORDER),
    [workAvailable],
  );
  const selectDetail = useSelectWorkspaceDetail(); // fork: work
  if (enabled.length === 0 && workspace.state.selectedTab !== "work") return <WorkspaceNoTabs />;
  return (
    <WorkspaceTabPanes
      tabs={tabs}
      selected={workspace.state.selectedTab}
      renderTab={(tab) =>
        tab === "threads" ? (
          props.children
        ) : tab === "work" ? ( // fork: work
          <WorkspaceTabsContext value={context}>
            <View className="flex-1 bg-header">
              <AndroidScreenHeader title="Work" />
              <ScreenContent insetHorizontal>
                <WorkScreen
                  sidebar
                  onOpenChat={(params) => selectDetail({ name: "Thread", params })}
                />
              </ScreenContent>
            </View>
          </WorkspaceTabsContext>
        ) : tab !== "pullRequests" ? (
          <View className="flex-1 bg-screen" />
        ) : (
          <WorkspaceTabsContext value={context}>
            <PullRequestsScreen
              sidebar
              selectedPullRequestKey={props.selectedPullRequestKey}
              renderFrame={(filters, list) => (
                <View className="flex-1 bg-header">
                  <PullRequestToolbar
                    filters={filters}
                    onRequestVisibility={props.onRequestVisibility}
                  />
                  <ScreenContent insetHorizontal>{list}</ScreenContent>
                </View>
              )}
            />
          </WorkspaceTabsContext>
        )
      }
    />
  );
}
