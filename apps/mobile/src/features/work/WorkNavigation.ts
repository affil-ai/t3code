import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ProjectId, ScheduledTask, ThreadId } from "@t3tools/contracts";
import { Keyboard, Platform } from "react-native";

import { useWorkspaceEnvironments } from "../../state/workspace";
import { startScheduledTaskEditor } from "../settings/scheduled-task-editor-state";
import { editDraft } from "../settings/scheduledTaskDraft";
import { useAndroidWorkspaceSelection } from "../workspace/useAndroidWorkspaceSelection";

/**
 * Where the Work tab's rows lead. A task opens its detail the way a pull
 * request opens from its list: pushed on a phone, in the detail column of a
 * split view. Automations open the scheduled-task editor in Settings.
 */
export function useWorkNavigation() {
  const navigation = useNavigation();
  const selectAndroidWorkspace = useAndroidWorkspaceSelection();
  const environments = useWorkspaceEnvironments();
  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)
      ?.environmentLabel ?? "Environment";

  return {
    openTask: (params: ReactNavigation.RootParamList["WorkTask"]) => {
      Keyboard.dismiss();
      if (Platform.OS === "android") selectAndroidWorkspace({ name: "WorkTask", params });
      else navigation.navigate("WorkTask", params);
    },
    editAutomation: (environmentId: EnvironmentId, task: ScheduledTask) => {
      startScheduledTaskEditor({
        environmentId,
        environmentLabel: environmentLabel(environmentId),
        draft: editDraft(task),
      });
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: { screen: "SettingsScheduledTaskEdit" },
      });
    },
    /** A new automation in the agent's project that posts into its chat. */
    newAutomation: (target: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
    }) =>
      navigation.navigate("SettingsSheet", {
        screen: "SettingsContent",
        params: {
          screen: "SettingsScheduledTaskNew",
          params: {
            environmentId: String(target.environmentId),
            projectId: String(target.projectId),
            threadId: String(target.threadId),
          },
        },
      }),
  };
}
