/** Slack as a `ChatPlatform`: what the core needs, on top of the Socket Mode host. */
import type { Access, ChannelRoute, ChatPlatform, ThreadRoute } from "../platform.ts";
import type { SlackChatHost } from "./host.ts";

/** Tells the agent how its answer reaches Slack, once per thread. */
export function slackFirstTurnNote(chatKey: string): string {
  return [
    "Your final message in each run is posted to this Slack thread.",
    "If a message needs no reply, end the run without a final message and nothing is posted.",
    "To mention someone there, write <@USERID>, such as <@U0123ABCD>.",
    `To send files, call the chat_post tool with chatKey "${chatKey}" and their paths in your workspace.`,
    `To react to a message, call the chat_react tool with chatKey "${chatKey}", the message id and an emoji name.`,
  ].join(" ");
}

/**
 * Slack for the bridge core. `host` is read on each call, so the core can be
 * built before Slack connects; a call before then throws.
 */
export function slackPlatform(options: {
  readonly host: () => SlackChatHost | undefined;
  readonly access: Access;
  readonly channelRoutes: ReadonlyArray<ChannelRoute>;
  readonly directRoute?: ThreadRoute | undefined;
}): ChatPlatform {
  const connected = () => {
    const host = options.host();
    if (host === undefined) throw new Error("Slack is not connected yet.");
    return host;
  };
  return {
    id: "slack",
    name: "Slack",
    place: "Slack thread",
    access: options.access,
    isEligible: (userId) => connected().isWorkspaceMember(userId),
    channelRoutes: options.channelRoutes,
    directRoute: options.directRoute,
    person: (userId, name) => `${name} (<@${userId}>)`,
    firstTurnNote: (chatKey) => slackFirstTurnNote(chatKey),
    refusal: (userId) =>
      `Sorry, you can't use this bot yet. Ask whoever runs it to add your Slack member ID (${userId}) to its allowed users.`,
    post: (message) => connected().post(message),
    react: (reaction) => connected().react(reaction),
    postBlocks: (message) => connected().postBlocks(message),
    updateBlocks: (message) => connected().updateBlocks(message),
    // Before Slack connects there is no status to set.
    setState: async (chatThreadKey, state, text) =>
      options.host()?.setState(chatThreadKey, state, text),
    rename: (chatThreadKey, title) => connected().rename(chatThreadKey, title),
    download: (url) => connected().download(url),
    history: (chatThreadKey, messageId) => connected().history(chatThreadKey, messageId),
    bound: (chatThreadKey) => connected().follow(chatThreadKey),
  };
}
