/**
 * The keychain item the iOS Standup widget fetches the standup with: the
 * Work environment's address and its bearer token. The device builds' Apple
 * team cannot sign App Groups, so instead of a shared container the widget
 * extension shares the app's keychain access group. The item is readable
 * after first unlock, so StandBy can refresh while the phone is locked.
 *
 * The widget reads it in `plugins/standup-widget/StandupWidget.swift`; keep
 * the service, key and JSON fields in step with it.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { requireOptionalNativeModule } from "expo";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const KEY = "credential";
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: "t3work.standup-widget",
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export interface StandupWidgetCredential {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
  readonly token: string;
  /** Where a tap on the widget leads: the app's Work tab. */
  readonly openUrl: string;
}

const widgets = requireOptionalNativeModule<{ reloadAllWidgets(): void }>("ExpoWidgets");
let published: string | null = null;

export async function publishStandupWidgetCredential(
  credential: StandupWidgetCredential,
): Promise<void> {
  const value = JSON.stringify(credential);
  if (Platform.OS !== "ios" || published === value) return;
  await SecureStore.setItemAsync(KEY, value, OPTIONS);
  published = value;
  widgets?.reloadAllWidgets();
}

/**
 * Takes the credential away when its environment is removed, so the widget
 * stops showing a server the phone no longer uses.
 */
export async function clearStandupWidgetCredential(environmentId: EnvironmentId): Promise<void> {
  if (Platform.OS !== "ios") return;
  const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
  if (raw === null) return;
  const stored = JSON.parse(raw) as Partial<StandupWidgetCredential>;
  if (stored.environmentId !== environmentId) return;
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
  published = null;
  widgets?.reloadAllWidgets();
}
