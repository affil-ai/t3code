import { useWorkspaceSidebarHeaderItem } from "../layout/useWorkspaceSidebarHeaderItem";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { threadHeaderAppearance } from "./thread-header-appearance";
import { isDuoDevice } from "../../lib/device-type";
import type { AppNativeStackNavigationOptions } from "../../native/StackHeader";
import { useDeviceType } from "../../native/native-layout-metrics";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import {
  ThreadGitControls,
  useThreadGitCenterHeaderItems,
  useThreadGitRightHeaderItems,
} from "./ThreadGitControls";

type NativeHeaderItems = ReadonlyArray<Record<string, unknown>>;

export function useThreadHeaderOptions(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly headerColor: string;
  readonly usesNativeHeaderGlass: boolean;
  readonly gitControls: Parameters<typeof ThreadGitControls>[0];
  readonly onReturnToThread?: () => void;
  /** fork: agents. Opens the task this worker chat runs; omitted on other chats. */
  readonly onOpenTask?: () => void;
  readonly draft?: boolean;
}) {
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const deviceType = useDeviceType();
  const usesDuoHeader = usesNativeWorkspaceColumns && isDuoDevice(deviceType);
  const navigation = useNavigation();
  const { layout, startNewTask } = useAdaptiveWorkspaceLayout();
  const sidebarHeaderItem = useWorkspaceSidebarHeaderItem();
  const threadCenterHeaderItems = useThreadGitCenterHeaderItems(props.gitControls);
  const compactRightHeaderItems = useThreadGitRightHeaderItems(props.gitControls);
  const splitLeftHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      ...(!usesDuoHeader
        ? [
            {
              spacing: 18,
              type: "spacing" as const,
            },
          ]
        : []),
      ...(props.onReturnToThread
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Return to chat",
              icon: { name: "chevron.left", type: "sfSymbol" as const },
              identifier: "thread-left-return",
              onPress: props.onReturnToThread,
              type: "button" as const,
            }),
          ]
        : []),
      sidebarHeaderItem,
      ...(!usesDuoHeader && !props.draft
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "New task",
              icon: { name: "square.and.pencil", type: "sfSymbol" as const },
              identifier: "thread-left-new-task",
              label: "New task",
              onPress: startNewTask,
              type: "button" as const,
            }),
          ]
        : []),
    ],
    [sidebarHeaderItem, props.onReturnToThread, props.draft, startNewTask, usesDuoHeader],
  );
  // fork: agents. A worker chat opens its task's details from the header, never the timeline.
  const taskHeaderItems = useMemo<NativeHeaderItems>(
    () =>
      props.onOpenTask
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Task details",
              icon: { name: "info.circle", type: "sfSymbol" as const },
              identifier: "thread-right-open-task",
              onPress: props.onOpenTask,
              type: "button" as const,
            }),
          ]
        : [],
    [props.onOpenTask],
  );
  const canGoBack = navigation.canGoBack();
  const compactHomeHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      withNativeGlassHeaderItem({
        accessibilityLabel: "Go to threads list",
        icon: { name: "list.bullet", type: "sfSymbol" as const },
        identifier: "thread-left-home",
        onPress: () => navigation.dispatch(StackActions.replace("Home")),
        type: "button" as const,
      }),
    ],
    [navigation],
  );

  const options: AppNativeStackNavigationOptions = {
    ...threadHeaderAppearance(props.usesNativeHeaderGlass),
    headerTitle: props.title,
    title: props.title,
    headerBackVisible: !layout.usesSplitView,
    unstable_headerLeftItems: layout.usesSplitView
      ? () => splitLeftHeaderItems
      : canGoBack
        ? undefined
        : () => compactHomeHeaderItems,
    // The workspace navigator adds compose to the Duo detail column's bar.
    unstable_headerRightItems: () => [
      ...taskHeaderItems, // fork: agents
      ...(usesDuoHeader || layout.usesSplitView
        ? threadCenterHeaderItems
        : compactRightHeaderItems),
    ],
    unstable_headerToolbarItems: () => [],
    unstable_headerSubtitle: props.usesNativeHeaderGlass ? props.subtitle : undefined,
    contentStyle: undefined,
  };
  const { environmentId, threadId, gitStatus } = props.gitControls;
  return {
    options,
    // Factories re-read only on version changes; include displayed items and hidden callback state such as default refs.
    optionsVersion: [
      splitLeftHeaderItems,
      threadCenterHeaderItems,
      compactRightHeaderItems,
      taskHeaderItems, // fork: agents
      usesDuoHeader,
      environmentId,
      threadId,
      gitStatus?.isDefaultRef,
      gitStatus?.refName,
      gitStatus?.pr?.url,
    ],
    sidebar: false,
    fallback:
      !layout.usesSplitView && !props.usesNativeHeaderGlass ? (
        <ThreadGitControls {...props.gitControls} showActionControls />
      ) : null,
  };
}
