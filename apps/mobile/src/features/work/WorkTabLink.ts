import { StackActions, useNavigation } from "@react-navigation/native";
import * as Linking from "expo-linking";
import { useEffect } from "react";

import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { useWorkTabAvailable } from "./WorkTabState";

/**
 * The Standup widget opens `t3code://?tab=work`. A cold start already lands on
 * Work; a running app may sit on another tab or have a chat pushed over the
 * workspace, and every tap repeats the same URL, so this listens for each
 * open. Call from the Home screen, inside its `WorkspaceTabsProvider`.
 */
export function useWorkTabLink() {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  const available = useWorkTabAvailable();
  useEffect(() => {
    if (!available || dispatch === undefined) return;
    const subscription = Linking.addEventListener("url", ({ url }) => {
      if (Linking.parse(url).queryParams?.tab !== "work") return;
      if (navigation.canGoBack()) navigation.dispatch(StackActions.popToTop());
      dispatch({ type: "select", tab: "work" });
    });
    return () => subscription.remove();
  }, [available, dispatch, navigation]);
}
