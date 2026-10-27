import { requireNativeView } from "expo";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useControlTheme } from "../../components/ui/useControlTheme";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import type { WorkspaceTab } from "./workspace-tabs-state";
import { useWorkTabAvailable } from "../work/WorkTabState"; // fork: work

// The native bar identifies each item by a fixed tag, whatever order it draws them in.
const TAB_TAGS: Record<WorkspaceTab, number> = { threads: 0, pullRequests: 1, work: 2 };
const TAG_TABS: ReadonlyArray<WorkspaceTab> = ["threads", "pullRequests", "work"];

const NativeSidebarTabBar = requireNativeView<
  ViewProps & {
    selectedIndex: number;
    showsWork: boolean; // fork: work
    selectedColor: string;
    appearance: string;
    onSelectionChange: (event: NativeSyntheticEvent<{ index: number }>) => void;
  }
>("T3NativeControls", "SidebarTabBar");

export function WorkspaceSidebarTabs() {
  const workspace = useWorkspaceTabs()!;
  const selectTab = useSelectWorkspaceTab();
  const insets = useSafeAreaInsets();
  const { colors, colorScheme } = useControlTheme();
  const showsWork = useWorkTabAvailable(); // fork: work
  return (
    <NativeSidebarTabBar
      selectedIndex={TAB_TAGS[workspace.state.selectedTab]}
      showsWork={showsWork}
      selectedColor={colors["--color-primary"]}
      appearance={colorScheme}
      onSelectionChange={({ nativeEvent }) => selectTab(TAG_TABS[nativeEvent.index] ?? "threads")}
      style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 64 + insets.bottom }}
    />
  );
}
