/** A Slack app manifest for the bridge, in Socket Mode, so it needs no public URL. */
export function slackAppManifest(appName: string): string {
  return JSON.stringify(
    {
      display_information: { name: appName },
      features: {
        bot_user: { display_name: appName, always_online: true },
        // Lets people send the bot direct messages from its Messages tab, as agent tasks.
        app_home: {
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
          agent_tasks_enabled: true,
        },
        // Slack's agent experience: session status, the stop button, titles and streamed task rows.
        agent_view: { suggested_prompts: [] },
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "channels:history",
            "groups:history",
            // Direct messages to the bot.
            "im:history",
            "chat:write",
            // Read the files people attach, and upload the files the agent sends.
            "files:read",
            "files:write",
            // React to messages through chat_react.
            "reactions:write",
            // Agent session status, titles and streaming.
            "assistant:write",
            "users:read",
          ],
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: [
            "agent_session_stopped",
            "app_context_changed",
            "app_mention",
            "message.channels",
            "message.groups",
            "message.im",
          ],
        },
        org_deploy_enabled: false,
        // The answer buttons under agents' questions.
        interactivity: { is_enabled: true },
        socket_mode_enabled: true,
        token_rotation_enabled: false,
      },
    },
    null,
    2,
  );
}
