import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ProjectId, ScheduledTask, ThreadId } from "@t3tools/contracts";
import { Keyboard } from "react-native";

import { useWorkspaceEnvironments } from "../../state/workspace";
import { startScheduledTaskEditor } from "../settings/scheduled-task-editor-state";
import { openSettings } from "../settings/settings-navigation";
import { editDraft } from "../settings/scheduledTaskDraft";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";

/**
 * Where the Work tab's rows lead. A task opens its detail the way a pull
 * request opens from its list: selected as the workspace's page, so a phone
 * shows it over the list and a split view in the detail column. Automations
 * open the scheduled-task editor in Settings.
 */
export function useWorkNavigation() {
  const navigation = useNavigation();
  const selectDetail = useSelectWorkspaceDetail();
  const environments = useWorkspaceEnvironments();
  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)
      ?.environmentLabel ?? "Environment";

  return {
    openTask: (params: ReactNavigation.RootParamList["WorkTask"]) => {
      Keyboard.dismiss();
      selectDetail({ name: "WorkTask", params });
    },
    editAutomation: (environmentId: EnvironmentId, task: ScheduledTask) => {
      startScheduledTaskEditor({
        environmentId,
        environmentLabel: environmentLabel(environmentId),
        draft: editDraft(task),
      });
      openSettings(navigation, "SettingsScheduledTaskEdit");
    },
    /** A new automation in the agent's project that posts into its chat. */
    newAutomation: (target: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
    }) =>
      openSettings(navigation, "SettingsScheduledTaskNew", {
        environmentId: String(target.environmentId),
        projectId: String(target.projectId),
        threadId: String(target.threadId),
      }),
  };
}
