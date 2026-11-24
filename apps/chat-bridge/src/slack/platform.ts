/** Slack as a `ChatPlatform`: what the core needs, on top of the Socket Mode host. */
import {
  type Access,
  type ChannelRoute,
  type ChatPlatform,
  DELIVER_FIRST,
  postRules,
  type ThreadRoute,
} from "../platform.ts";
import type { InboundEvent } from "../bridge.ts";
import type { SlackChatHost, SlackTransport } from "./host.ts";
import { SLACK_REPLY_STYLE } from "./replyStyle.ts";

/**
 * Who `allowEveryone` admits on a transport. Behind Office's relay, Office already accepted
 * the event, so any person counts, guests and Slack Connect included; Socket Mode keeps
 * full members only.
 */
export const slackEligibility = (transport: SlackTransport): "workspace" | "person" =>
  transport.kind === "office-relay" ? "person" : "workspace";

/**
 * How the agent acknowledges a request in Slack: the status line, and an eyes reaction
 * only when an answer won't come soon. The tool server refuses a second eyes per request.
 */
export const SLACK_ACKNOWLEDGE =
  "React rarely. Use chat_react (eyes) at most once per request, on the message that asks you for work you won't answer within about a minute. Don't react when you'll answer in this run, or to follow-ups, answers to your questions, thanks, asides or messages not addressed to you. When you take on work, set chat_status to the step you're on, and again at each new step.";

/** John Ta's Slack user id. He asked that agents not react to his messages. */
export const JOHN_TA_SLACK_ID = "U0791S1K34N";

/** Added to the first turn of a chat John Ta starts. */
export const NO_REACT_TO_STARTER =
  "This chat was started by John Ta: don't react to his messages (no chat_react, eyes included).";

/** Tells the agent how its answer reaches Slack, once per thread. `start` is the message that started it. */
export function slackFirstTurnNote(chatKey: string, start?: Pick<InboundEvent, "author">): string {
  return [
    postRules("Slack thread"),
    SLACK_ACKNOWLEDGE,
    ...(start?.author.userId === JOHN_TA_SLACK_ID ? [NO_REACT_TO_STARTER] : []),
    DELIVER_FIRST,
    SLACK_REPLY_STYLE,
    "To mention someone there, write <@USERID>, such as <@U0123ABCD>.",
    `The chat tools take chatKey "${chatKey}". chat_post sends text, files from your workspace, or both; chat_react takes the message id and an emoji name.`,
  ].join(" ");
}

/** What a thread that started its own Slack thread is told, with the key for the chat tools. */
export function slackWorkNote(chatThreadKey: string, chatKey: string): string {
  return [
    `You started a Slack thread (${chatThreadKey}). Replies there continue this thread.`,
    slackFirstTurnNote(chatKey),
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
  /** Where a mention in an unlisted channel the bot is a member of starts; see `slack.memberChannels`. */
  readonly memberRoute?: ThreadRoute | undefined;
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
    ...(options.memberRoute === undefined
      ? {}
      : {
          memberRoute: async (channelId: string) =>
            (await connected().isMemberChannel(channelId)) ? options.memberRoute : undefined,
        }),
    directRoute: options.directRoute,
    person: (userId, name) => `${name} (<@${userId}>)`,
    firstTurnNote: slackFirstTurnNote,
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
    silentByDefault: true,
    backgroundStatus: true,
    startConversation: (channel, text, replyTo) => connected().startThread(channel, text, replyTo),
  };
}
