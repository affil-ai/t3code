import * as Linking from "expo-linking";
import { useEffect } from "react";
import { Platform } from "react-native";

import { useAgentsHome } from "../state/agents";
import { useSavedRemoteConnection } from "../state/use-remote-environment-registry";
import { publishStandupWidgetCredential } from "./standupWidgetKeychain";

/**
 * Keeps the Standup widget's credential on the environment that serves Work.
 * A relay connection has no bearer token; the widget then asks to open the
 * app. Mount once.
 */
export function StandupWidgetCredentialSync() {
  const environmentId = useAgentsHome()?.environmentId ?? null;
  const connection = useSavedRemoteConnection(environmentId);
  const httpBaseUrl = connection?.httpBaseUrl ?? null;
  const token = connection?.bearerToken ?? null;
  useEffect(() => {
    if (Platform.OS !== "ios" || environmentId === null || !httpBaseUrl || !token) return;
    publishStandupWidgetCredential({
      environmentId,
      httpBaseUrl,
      token,
      openUrl: Linking.createURL("/", { queryParams: { tab: "work" } }),
    }).catch((error: unknown) =>
      console.warn("Could not share the standup widget's credential", error),
    );
  }, [environmentId, httpBaseUrl, token]);
  return null;
}
