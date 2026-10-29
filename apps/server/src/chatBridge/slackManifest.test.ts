import { assert, it } from "@effect/vitest";

import { slackAppManifest, WEBHOOK_URL_PLACEHOLDER } from "./slackManifest.ts";

it("enables Socket Mode without a request URL for the socket transport", () => {
  const manifest = JSON.parse(
    slackAppManifest({ appName: "T3", transport: "socket", webhookUrl: null }),
  );
  assert.isTrue(manifest.settings.socket_mode_enabled);
  assert.notProperty(manifest.settings.event_subscriptions, "request_url");
  assert.includeMembers(manifest.settings.event_subscriptions.bot_events, [
    "app_mention",
    "message.channels",
  ]);
});

it("points webhook delivery at the relay hook URL, or a placeholder until there is one", () => {
  const url = "https://relay.example/v1/hooks/abc/chat-slack/token";
  const withUrl = JSON.parse(
    slackAppManifest({ appName: "T3", transport: "webhook", webhookUrl: url }),
  );
  assert.isFalse(withUrl.settings.socket_mode_enabled);
  assert.strictEqual(withUrl.settings.event_subscriptions.request_url, url);
  const without = JSON.parse(
    slackAppManifest({ appName: "T3", transport: "webhook", webhookUrl: null }),
  );
  assert.strictEqual(without.settings.event_subscriptions.request_url, WEBHOOK_URL_PLACEHOLDER);
});

it("asks for the file scopes the bridge uses to import and send files", () => {
  const manifest = JSON.parse(
    slackAppManifest({ appName: "T3", transport: "socket", webhookUrl: null }),
  );
  assert.includeMembers(manifest.oauth_config.scopes.bot, ["files:read", "files:write"]);
});
