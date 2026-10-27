import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { PullRequestFilterMenuProvider } from "../pull-requests/PullRequestFilterMenuContext";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { PullRequestToolbar } from "../pull-requests/PullRequestToolbar.android";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader"; // fork: work
import { WorkScreen } from "../work/WorkScreen"; // fork: work
import { useVisibleWorkspaceTabs } from "../work/WorkTabState"; // fork: work
import { useAndroidWorkspaceSelection } from "./useAndroidWorkspaceSelection"; // fork: work

export function AndroidWorkspaceSidebar(props: {
  readonly children: ReactNode;
  readonly onRequestVisibility: () => void;
  readonly selectedPullRequestKey: string | null;
}) {
  const workspace = useWorkspaceTabs()!;
  const context = useMemo(() => ({ ...workspace, bottomClearance: 16 }), [workspace]);
  const tabs = useVisibleWorkspaceTabs(); // fork: work
  const selectAndroidWorkspace = useAndroidWorkspaceSelection(); // fork: work
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
                  onOpenChat={(params) => selectAndroidWorkspace({ name: "Thread", params })}
                />
              </ScreenContent>
            </View>
          </WorkspaceTabsContext>
        ) : (
          <WorkspaceTabsContext value={context}>
            <PullRequestFilterMenuProvider>
              <View className="flex-1 bg-header">
                <PullRequestToolbar onRequestVisibility={props.onRequestVisibility} />
                <ScreenContent insetHorizontal>
                  <PullRequestsScreen
                    sidebar
                    selectedPullRequestKey={props.selectedPullRequestKey}
                  />
                </ScreenContent>
              </View>
            </PullRequestFilterMenuProvider>
          </WorkspaceTabsContext>
        )
      }
    />
  );
}
