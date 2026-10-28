import { selectedNavigationTab, visibleNavigationTabs } from "./navigation-tab-order";
import { requireNativeView } from "expo";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { useControlTheme } from "../../components/ui/useControlTheme";
import { useNavigationTabOrder, useHiddenNavigationTabs } from "./navigation-tabs";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import { useWorkTabAvailable } from "../work/WorkTabState"; // fork: work
import { navigationTabCapacity, visibleWorkspaceTabs } from "../work/WorkTab.logic"; // fork: work

const NativeSidebarTabBar = requireNativeView<
  ViewProps & {
    tabs: readonly string[];
    selectedTab: string;
    selectedColor: string;
    appearance: string;
    showsCompose: boolean;
    compact?: boolean;
    onSelectionChange: (event: NativeSyntheticEvent<{ tab: string }>) => void;
    onCompose: () => void;
  }
>("T3NativeControls", "SidebarTabBar");

export function WorkspaceSidebarTabs(props: {
  readonly onNewTask?: () => void;
  readonly compact?: boolean;
  readonly reserveComposeSpace?: boolean;
}) {
  const workspace = useWorkspaceTabs()!;
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  // fork: work: Work leads the bar and takes one of its slots.
  const workAvailable = useWorkTabAvailable();
  const capacity = navigationTabCapacity(4, workAvailable);
  const tabs = [
    ...visibleWorkspaceTabs(workAvailable, visibleNavigationTabs(order, hidden, capacity)),
    "settings" as const,
  ];
  const selectedTab = workspace.state.selectedTab;
  const selectTab = useSelectWorkspaceTab();
  const { colors, colorScheme } = useControlTheme();
  // UIKit loses accessible names when updating nil-titled items in place.
  const tabBarKey = tabs.join(":");
  return (
    <NativeSidebarTabBar
      key={tabBarKey}
      tabs={tabs}
      selectedTab={
        selectedTab === "work" // fork: work
          ? workspace.settingsOpen
            ? "settings"
            : "work"
          : selectedNavigationTab(order, selectedTab, workspace.settingsOpen, hidden, capacity)
      }
      selectedColor={colors["--color-primary"]}
      appearance={colorScheme}
      showsCompose={Boolean(props.onNewTask)}
      compact={props.compact}
      onCompose={() => props.onNewTask?.()}
      onSelectionChange={({ nativeEvent }) => {
        const tab = tabs.find((candidate) => candidate === nativeEvent.tab);
        if (tab === "settings") selectTab("settings");
        else if (tab) selectTab(tab);
      }}
      // Keep the host stable while UIKit updates the bars' intrinsic size and safe area together.
      style={{
        position: "absolute",
        bottom: 0,
        left: props.compact ? 8 : 0,
        // Keep the tab icons in place when Compose disappears on other destinations.
        right:
          (props.compact ? 12 : 0) +
          ((props.reserveComposeSpace ?? props.compact) && !props.onNewTask
            ? props.compact
              ? 64
              : 76
            : 0),
        height: 128,
      }}
    />
  );
}
