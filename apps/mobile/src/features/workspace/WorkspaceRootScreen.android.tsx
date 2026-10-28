import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { WorkspaceExtraTab } from "./WorkspaceExtraTab";
import { useMemo } from "react";
import { View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { PullRequestToolbar } from "../pull-requests/PullRequestToolbar.android";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { AndroidWorkspaceNavigation } from "./AndroidWorkspaceNavigation";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import { WorkScreen } from "../work/WorkScreen"; // fork: work
import { useWorkTabAvailable } from "../work/WorkTabState"; // fork: work
import { visibleWorkspaceTabs } from "../work/WorkTab.logic"; // fork: work
import { useSelectWorkspaceDetail } from "./useSelectWorkspaceDetail"; // fork: work

export function WorkspaceRootScreen() {
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  // fork: work: Work leads the retained panes while a server runs agents.
  const workAvailable = useWorkTabAvailable();
  const tabs = useMemo(
    () => visibleWorkspaceTabs(workAvailable, NAVIGATION_TAB_ORDER),
    [workAvailable],
  );
  const selectDetail = useSelectWorkspaceDetail(); // fork: work
  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const context = useMemo(
    () => ({
      ...workspace,
      bottomClearance: workspace.state.selectedTab === "threads" ? fabClearance + 16 : 16,
    }),
    [workspace, fabClearance],
  );
  const tab = workspace.state.selectedTab;

  if (layout.usesSplitView) {
    if (enabled.length === 0 && tab !== "work") return <View className="flex-1 bg-screen" />;
    return (
      <WorkspaceTabPanes
        tabs={tabs}
        selected={tab}
        renderTab={(tab) =>
          tab === "threads" ? (
            <HomeRouteScreen />
          ) : tab !== "pullRequests" && tab !== "work" ? (
            <WorkspaceExtraTab tab={tab} />
          ) : (
            <>
              <NativeStackScreenOptions options={{ headerShown: false }} />
              <AndroidScreenHeader title={tab === "work" ? "Work" : "Pull requests"} />
              <View className="flex-1 items-center justify-center px-10">
                {tab === "work" ? ( // fork: work
                  <EmptyState
                    title="Select a task"
                    detail="Choose a task or chat from the sidebar."
                    variant="plain"
                  />
                ) : (
                  <EmptyState
                    title="Select a pull request"
                    detail="Choose a pull request from the sidebar to review it."
                    variant="plain"
                  />
                )}
              </View>
            </>
          )
        }
      />
    );
  }

  return (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-header">
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <SafeAreaInsetsContext value={{ ...insets, bottom: 0 }}>
          {enabled.length === 0 && tab !== "work" ? (
            <WorkspaceNoTabs />
          ) : (
            <WorkspaceTabPanes
              tabs={tabs}
              selected={tab}
              renderTab={(tab) =>
                tab === "threads" ? (
                  <HomeRouteScreen />
                ) : tab === "work" ? ( // fork: work
                  <>
                    <AndroidScreenHeader title="Work" />
                    <ScreenContent>
                      <WorkScreen
                        onOpenChat={(params) => selectDetail({ name: "Thread", params })}
                      />
                    </ScreenContent>
                  </>
                ) : tab !== "pullRequests" ? (
                  <WorkspaceExtraTab tab={tab} />
                ) : (
                  <PullRequestsScreen
                    renderFrame={(filters, list) => (
                      <>
                        <PullRequestToolbar filters={filters} />
                        <ScreenContent>{list}</ScreenContent>
                      </>
                    )}
                  />
                )
              }
            />
          )}
        </SafeAreaInsetsContext>
        <AndroidWorkspaceNavigation onNewThread={startNewTask} />
      </View>
    </WorkspaceTabsContext>
  );
}
