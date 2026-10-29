import { Keyboard, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WORKSPACE_DOCK } from "./workspace-tabs-state";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useVisibleWorkspaceTabs } from "../work/WorkTabState"; // fork: work

const DOCK_TABS = {
  work: { label: "Work", icon: "person.2" },
  threads: { label: "Threads", icon: "text.bubble" },
  pullRequests: { label: "Pull requests", icon: PullRequestGlyph.pullRequest },
  usage: { label: "Usage", icon: "chart.bar.xaxis" },
} as const; // fork: work

export function WorkspaceDock(props: { readonly onNewTask: () => void }) {
  const workspace = useWorkspaceTabs()!;
  const tabs = useVisibleWorkspaceTabs(); // fork: work
  return (
    <View
      className="w-full flex-row items-center justify-between"
      style={{ gap: WORKSPACE_DOCK.gap }}
    >
      <GlassSurface
        style={{
          width: (WORKSPACE_DOCK.tabsWidth / 2) * tabs.length, // fork: work
          height: WORKSPACE_DOCK.height,
          borderRadius: WORKSPACE_DOCK.height / 2,
        }}
      >
        <View className="flex-1 flex-row p-1" accessibilityRole="tablist">
          {tabs.map((tab) => {
            const selected = workspace.state.selectedTab === tab;
            return (
              <Pressable
                key={tab}
                accessibilityRole="tab"
                accessibilityLabel={DOCK_TABS[tab].label}
                accessibilityState={{ selected }}
                onPress={() => {
                  if (selected) return;
                  Keyboard.dismiss();
                  workspace.dispatch({ type: "select", tab });
                }}
                className={
                  selected
                    ? "flex-1 items-center justify-center rounded-full bg-subtle-strong"
                    : "flex-1 items-center justify-center rounded-full"
                }
              >
                <SymbolView
                  name={DOCK_TABS[tab].icon}
                  size={23}
                  tintColorClassName={selected ? "accent-focus" : "accent-icon"}
                />
              </Pressable>
            );
          })}
        </View>
      </GlassSurface>
      <GlassSurface
        style={{
          width: WORKSPACE_DOCK.height,
          height: WORKSPACE_DOCK.height,
          borderRadius: WORKSPACE_DOCK.height / 2,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          onPress={props.onNewTask}
          className="flex-1 items-center justify-center"
        >
          <SymbolView name="square.and.pencil" size={23} tintColorClassName="accent-icon" />
        </Pressable>
      </GlassSurface>
    </View>
  );
}
