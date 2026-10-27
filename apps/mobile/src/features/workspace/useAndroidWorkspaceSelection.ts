import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Keyboard } from "react-native";
import {
  resetAndroidWorkspace,
  type AndroidWorkspaceDestination,
} from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

export function useAndroidWorkspaceSelection() {
  const navigation = useNavigation();
  const workspaceTabs = useWorkspaceTabs();
  const dispatch = workspaceTabs?.dispatch;
  const isTabActive = workspaceTabs?.isTabActive;
  return useCallback(
    (
      destination: AndroidWorkspaceDestination,
      reviewers?: ReactNavigation.RootParamList["PullRequestReviewers"],
    ) => {
      Keyboard.dismiss();
      // fork: work. A chat opened from Work keeps Work selected; the Thread route
      // then picks its own tab on focus, so agent chats never flash Threads.
      if (!(destination.name === "Thread" && isTabActive?.("work"))) {
        dispatch?.({
          type: "select",
          tab:
            destination.name === "Thread"
              ? "threads"
              : destination.name === "WorkTask" // fork: work
                ? "work"
                : "pullRequests",
        });
      }
      resetAndroidWorkspace(navigation, destination, reviewers);
    },
    [navigation, dispatch, isTabActive],
  );
}
