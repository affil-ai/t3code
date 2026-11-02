import { useAndroidFloatingTabs } from "../settings/appearance/AppearancePreferencesProvider";
import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { WorkspaceExtraTab } from "./WorkspaceExtraTab";
import { useWindowDimensions, View } from "react-native";
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
import { AndroidWorkspaceNavigation, FloatingWorkspaceTabs } from "./AndroidWorkspaceNavigation";
import { FLOATING_TABS, floatingTabsMetrics } from "./floating-workspace-tabs";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import { WorkScreen } from "../work/WorkScreen"; // fork: work
import { useWorkTabAvailable } from "../work/WorkTabState"; // fork: work
import { visibleWorkspaceTabs } from "../work/WorkTab.logic"; // fork: work
import { useSelectWorkspaceDetail } from "./useSelectWorkspaceDetail"; // fork: work

export function WorkspaceRootScreen() {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  // fork: work: Work leads the retained panes while a server runs agents.
  const workAvailable = useWorkTabAvailable();
  const tabs = visibleWorkspaceTabs(workAvailable, NAVIGATION_TAB_ORDER);
  const selectDetail = useSelectWorkspaceDetail(); // fork: work
  const insets = useSafeAreaInsets();
  const { fabClearance, scale, fabSize } = useAndroidControlSizing();
  const window = useWindowDimensions();
  // fork: work. Work takes a slot in the bar.
  const barTabCount = (workAvailable ? enabled.length + 1 : enabled.length) + 1;
  const floating = floatingTabsMetrics(barTabCount, scale, fabSize, window.width);
  const context = {
    ...workspace,
    bottomClearance: layout.usesSplitView
      ? workspace.bottomClearance
      : floatingTabsEnabled
        ? insets.bottom +
          FLOATING_TABS.bottom +
          FLOATING_TABS.edge +
          Math.max(
            floating.height,
            workspace.state.selectedTab === "threads" ? floating.fabOffset + fabSize : 0,
          )
        : workspace.state.selectedTab === "threads"
          ? fabClearance + 16
          : 16,
  };
  const tab = workspace.state.selectedTab;

  return (
    <WorkspaceTabsContext value={context}>
      <View className={layout.usesSplitView ? "flex-1 bg-screen" : "flex-1 bg-header"}>
        {!layout.usesSplitView ? (
          <NativeStackScreenOptions options={{ headerShown: false }} />
        ) : null}
        <SafeAreaInsetsContext
          value={
            layout.usesSplitView
              ? insets
              : floatingTabsEnabled
                ? tab === "usage"
                  ? { ...insets, bottom: context.bottomClearance }
                  : insets
                : { ...insets, bottom: 0 }
          }
        >
          {enabled.length === 0 && tab !== "work" ? (
            layout.usesSplitView ? (
              <View className="flex-1 bg-screen" />
            ) : (
              <WorkspaceNoTabs />
            )
          ) : (
            <WorkspaceTabPanes
              tabs={tabs}
              selected={tab}
              renderTab={(tab) =>
                tab === "threads" ? (
                  <HomeRouteScreen />
                ) : tab === "work" ? ( // fork: work
                  layout.usesSplitView ? (
                    <>
                      <NativeStackScreenOptions options={{ headerShown: false }} />
                      <AndroidScreenHeader title="Work" />
                      <View className="flex-1 items-center justify-center px-10">
                        <EmptyState
                          title="Select a task"
                          detail="Choose a task or chat from the sidebar."
                          variant="plain"
                        />
                      </View>
                    </>
                  ) : (
                    <>
                      <AndroidScreenHeader title="Work" />
                      <ScreenContent>
                        <WorkScreen
                          onOpenChat={(params) => selectDetail({ name: "Thread", params })}
                        />
                      </ScreenContent>
                    </>
                  )
                ) : tab !== "pullRequests" ? (
                  <WorkspaceExtraTab tab={tab} />
                ) : layout.usesSplitView ? (
                  <>
                    <NativeStackScreenOptions options={{ headerShown: false }} />
                    <AndroidScreenHeader title="Pull requests" />
                    <View className="flex-1 items-center justify-center px-10">
                      <EmptyState
                        title="Select a pull request"
                        detail="Choose a pull request from the sidebar to review it."
                        variant="plain"
                      />
                    </View>
                  </>
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
        {layout.usesSplitView ? null : floatingTabsEnabled ? (
          <FloatingWorkspaceTabs fillWidth onNewThread={startNewTask} />
        ) : (
          <AndroidWorkspaceNavigation onNewThread={startNewTask} />
        )}
      </View>
    </WorkspaceTabsContext>
  );
}
