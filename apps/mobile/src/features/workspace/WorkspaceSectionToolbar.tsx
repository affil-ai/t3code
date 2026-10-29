import { selectedNavigationTab, visibleNavigationTabs } from "./navigation-tab-order";
import { Toolbar } from "../../components/ui/Toolbar";
import { useControlTheme } from "../../components/ui/useControlTheme";
import { useDeviceType } from "../../native/native-layout-metrics";
import {
  NAVIGATION_TAB_ICONS,
  useNavigationTabOrder,
  useHiddenNavigationTabs,
} from "./navigation-tabs";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { useSelectWorkspaceTab } from "./useSelectWorkspaceTab";
import { useCompactWorkspaceTabs, useSidebarWorkspaceTabs } from "./useSystemWorkspaceTabBar";
// fork: work
import { WORKSPACE_TAB_TITLES, useWorkTabAvailable } from "../work/WorkTabState";
import { navigationTabCapacity, visibleWorkspaceTabs } from "../work/WorkTab.logic"; // fork: work

const PULL_REQUEST_ICON = require("../../../assets/icons/pull-request.png");

export function WorkspaceTabToolbarButtons() {
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const workspace = useWorkspaceTabs()!;
  const selectTab = useSelectWorkspaceTab();
  // fork: work: Work leads the toolbar and takes one of its slots.
  const workAvailable = useWorkTabAvailable();
  const capacity = navigationTabCapacity(4, workAvailable);
  const selectedTab = workspace.state.selectedTab;
  const selected =
    selectedTab === "work"
      ? workspace.settingsOpen
        ? "settings"
        : "work"
      : selectedNavigationTab(order, selectedTab, workspace.settingsOpen, hidden, capacity);
  const tabs = visibleWorkspaceTabs(workAvailable, visibleNavigationTabs(order, hidden, capacity));
  const selectedTint = useControlTheme().colors["--color-primary"];
  return (
    <>
      {tabs.map((tab) => (
        <Toolbar.Button
          key={tab}
          identifier={`workspace-tab-${tab}`}
          accessibilityLabel={WORKSPACE_TAB_TITLES[tab]}
          icon={
            tab === "pullRequests"
              ? { type: "image", source: PULL_REQUEST_ICON, tinted: true }
              : tab === "work"
                ? selected === "work"
                  ? "person.2.fill"
                  : "person.2"
                : NAVIGATION_TAB_ICONS[tab]
          }
          tintColor={selected === tab ? selectedTint : undefined}
          onPress={() => selectTab(tab)}
        />
      ))}
      <Toolbar.Button
        identifier="workspace-tab-settings"
        accessibilityLabel="Settings"
        icon="gearshape"
        tintColor={selected === "settings" ? selectedTint : undefined}
        onPress={() => selectTab("settings")}
      />
    </>
  );
}

export function WorkspaceSectionToolbar({
  onNewTask,
  showCompose = true,
}: {
  readonly onNewTask: () => void;
  readonly showCompose?: boolean;
}) {
  const sidebarTabs = useSidebarWorkspaceTabs();
  const compactTabs = useCompactWorkspaceTabs();
  const deviceType = useDeviceType();
  return (
    <>
      {showCompose && sidebarTabs !== "picker" && deviceType !== "duo-unfolded" && !compactTabs ? (
        <Toolbar placement="right">
          <Toolbar.Button
            accessibilityLabel="New chat"
            icon="square.and.pencil"
            onPress={onNewTask}
          />
        </Toolbar>
      ) : null}
      {sidebarTabs === "toolbar" ? (
        <Toolbar placement="bottom">
          <WorkspaceTabToolbarButtons />
        </Toolbar>
      ) : null}
    </>
  );
}
