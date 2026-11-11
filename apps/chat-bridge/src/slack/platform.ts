/** Slack as a `ChatPlatform`: what the core needs, on top of the Socket Mode host. */
import {
  type Access,
  type ChannelRoute,
  type ChatPlatform,
  DELIVER_FIRST,
  QUIET_REPLY,
  QUIET_RULES,
  type ThreadRoute,
} from "../platform.ts";
import type { SlackChatHost, SlackTransport } from "./host.ts";

/**
 * Who `allowEveryone` admits on a transport. Behind Office's relay, Office already accepted
 * the event, so any person counts, guests and Slack Connect included; Socket Mode keeps
 * full members only.
 */
export const slackEligibility = (transport: SlackTransport): "workspace" | "person" =>
  transport.kind === "office-relay" ? "person" : "workspace";

/**
 * How Slack replies read. People skim a thread on a phone, so the bridge repeats
 * this on every Slack turn and in the tool server's instructions, which also
 * reach wakes from background work.
 */
export const SLACK_REPLY_STYLE =
  "Write for Slack: lead with the answer, in a few lines or a short list, not a report. Leave out commit SHAs, run or deployment IDs, file paths and tool narration unless the reader needs them to act; give a link instead of an ID. A progress update is one short sentence.";

/** Tells the agent how its answer reaches Slack, once per thread. */
export function slackFirstTurnNote(chatKey: string): string {
  return [
    "Your final message in each run is posted to this Slack thread.",
    QUIET_RULES,
    DELIVER_FIRST,
    SLACK_REPLY_STYLE,
    "To mention someone there, write <@USERID>, such as <@U0123ABCD>.",
    `To send files, call the chat_post tool with chatKey "${chatKey}" and their paths in your workspace.`,
    `To react to a message, call the chat_react tool with chatKey "${chatKey}", the message id and an emoji name.`,
  ].join(" ");
}

/** What a thread that started its own Slack thread is told, with the key for the chat tools. */
export function slackWorkNote(chatThreadKey: string, chatKey: string): string {
  return [
    `You started a Slack thread (${chatThreadKey}). Replies there continue this thread, and from now on your final message in each run is posted there.`,
    slackFirstTurnNote(chatKey),
    `If you had already finished when this arrived, answer ${QUIET_REPLY}.`,
    `Chat key: ${chatKey}`,
  ].join("\n\n");
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
  /**
   * Who `allowEveryone` admits. `workspace` (Socket Mode): full members only. `person`
   * (Office relay): Office already accepted the event, so any person who can reach the
   * Office app, guests and Slack Connect users included; bots stay out.
   */
  readonly eligibility?: "workspace" | "person";
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
    isEligible: (userId) =>
      options.eligibility === "person"
        ? connected().isPerson(userId)
        : connected().isWorkspaceMember(userId),
    channelRoutes: options.channelRoutes,
    directRoute: options.directRoute,
    person: (userId, name) => `${name} (<@${userId}>)`,
    firstTurnNote: (chatKey) => slackFirstTurnNote(chatKey),
    replyStyle: SLACK_REPLY_STYLE,
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
    feedbackTarget: (event) => connected().feedbackTarget(event),
    bound: (chatThreadKey) => connected().follow(chatThreadKey),
    acknowledgeFirst: true,
    backgroundStatus: true,
    startConversation: (channel, text, replyTo) => connected().startThread(channel, text, replyTo),
  };
}
