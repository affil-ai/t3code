import type { ChatBridgeSlackTransport } from "@t3tools/contracts";

/** Placeholder shown until this environment has a public hook URL. */
export const WEBHOOK_URL_PLACEHOLDER = "https://<your T3 Connect hook URL>";

/**
 * A Slack app manifest for the bridge. `reactions:write` is for step 2's
 * status reactions; asking now saves a reinstall later.
 */
export function slackAppManifest(input: {
  readonly appName: string;
  readonly transport: ChatBridgeSlackTransport;
  readonly webhookUrl: string | null;
}): string {
  const socket = input.transport === "socket";
  return JSON.stringify(
    {
      display_information: { name: input.appName },
      features: { bot_user: { display_name: input.appName, always_online: true } },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "channels:history",
            "groups:history",
            "chat:write",
            // Read the files people attach, and upload the files the agent sends.
            "files:read",
            "files:write",
            "reactions:write",
            "users:read",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          ...(socket ? {} : { request_url: input.webhookUrl ?? WEBHOOK_URL_PLACEHOLDER }),
          bot_events: ["app_mention", "message.channels", "message.groups"],
        },
        org_deploy_enabled: false,
        socket_mode_enabled: socket,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
}
