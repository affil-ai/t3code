/**
 * The Chat SDK side of the bridge. It owns the `Chat` instance and the Slack
 * adapter in Socket Mode, turns SDK messages into `InboundEvent`s for the
 * bridge, and posts its replies. Nothing here touches T3.
 */
import { createSlackAdapter, type SlackAdapter, SlackFormatConverter } from "@chat-adapter/slack";
import {
  Chat,
  type Logger,
  type Message,
  type MessageContext,
  type StateAdapter,
  type Thread,
} from "chat";

import type { EarlierMessage, InboundEvent, InboundOutcome, MentionedUser } from "./bridge.ts";
import type { InboundFile } from "./threads.ts";

export interface SlackChatHostOptions {
  readonly botToken: string;
  /** The app-level token (`xapp-…`) Socket Mode connects with. */
  readonly appToken: string;
  readonly state: StateAdapter;
  readonly onEvent: (event: InboundEvent) => Promise<InboundOutcome>;
  readonly onError: (error: unknown) => void;
  /** Tests point the Web API at an address that refuses connections. */
  readonly apiUrl?: string | undefined;
  /**
   * Receives the adapter's info, warning and error lines, with credentials
   * redacted. Debug lines are dropped because they carry request bodies.
   */
  readonly log?: ((level: "info" | "warn" | "error", line: string) => void) | undefined;
  /** Tests supply the bot's user id, which `auth.test` would otherwise return. */
  readonly botUserId?: string | undefined;
}

export interface SlackOutboundFile {
  readonly data: Buffer;
  readonly filename: string;
}

export interface SlackOutboundMessage {
  readonly chatThreadKey: string;
  readonly text: string;
  /** Uploaded with the message; needs the `files:write` scope. */
  readonly files?: ReadonlyArray<SlackOutboundFile> | undefined;
}

export interface SlackReaction {
  readonly chatThreadKey: string;
  /** The message's Slack `ts`; it must be in the chat thread. */
  readonly messageId: string;
  /** A Slack emoji name without colons, such as `eyes`. */
  readonly emoji: string;
}

export interface SlackChatHost {
  readonly post: (message: SlackOutboundMessage) => Promise<void>;
  /** Adds a reaction; reacting twice with the same emoji is not an error. */
  readonly react: (reaction: SlackReaction) => Promise<void>;
  /** Disconnects from Slack. */
  readonly shutdown: () => Promise<void>;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Drops the leading `@bot` the user typed to address the bot; other mentions
 * stay. Slack renders the mention with the bot's display name, which often
 * differs from its username, so the host passes both.
 */
export function stripBotMention(text: string, botNames: ReadonlyArray<string>): string {
  for (const name of botNames) {
    if (!name) continue;
    const stripped = text.replace(
      new RegExp(`^\\s*@${escapeRegExp(name)}(?=[\\s,:]|$)[,:]?\\s*`, "i"),
      "",
    );
    if (stripped !== text) return stripped.trim();
  }
  return text.trim();
}

const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^<>]*)?>/g;

/** User ids the raw Slack text mentions, in order, without repeats. */
export function mentionedUserIds(rawText: unknown, excludeId: string | undefined): Array<string> {
  if (typeof rawText !== "string") return [];
  const ids = [...rawText.matchAll(USER_MENTION)].map((match) => match[1] ?? "");
  return [...new Set(ids)].filter((id) => id !== "" && id !== excludeId);
}

function toInboundFile(attachment: Message["attachments"][number]): InboundFile {
  const fetchData = attachment.fetchData;
  return {
    name: attachment.name ?? attachment.type,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.size,
    fetch:
      fetchData === undefined
        ? undefined
        : async () => new Uint8Array(await fetchData.call(attachment)),
  };
}

/** The fields of a Slack `conversations.replies` message the bridge reads. */
export interface SlackRawMessage {
  readonly ts?: string | undefined;
  readonly user?: string | undefined;
  readonly bot_id?: string | undefined;
  readonly username?: string | undefined;
  readonly bot_profile?: { readonly name?: string | undefined } | undefined;
  readonly text?: string | undefined;
  readonly files?: ReadonlyArray<{ readonly name?: string | undefined }> | undefined;
}

/** Slack escapes only these three in message text; mention tokens keep their real angle brackets. */
const unescapeSlack = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** Slack `ts` values are decimal seconds; they compare as numbers. */
const tsBefore = (ts: string | undefined, before: string) =>
  ts !== undefined && Number(ts) < Number(before);

/**
 * The thread messages before `beforeTs`, oldest first, with names from
 * `nameOf`. Messages with neither text nor files, such as joins, are dropped.
 */
export async function toEarlierMessages(
  raw: ReadonlyArray<SlackRawMessage>,
  beforeTs: string,
  nameOf: (userId: string) => Promise<string>,
): Promise<Array<EarlierMessage>> {
  const earlier = raw
    .filter((message) => tsBefore(message.ts, beforeTs))
    .filter((message) => (message.text ?? "").trim() !== "" || (message.files ?? []).length > 0)
    .toSorted((a, b) => Number(a.ts) - Number(b.ts));
  return Promise.all(
    earlier.map(async (message) => {
      const userId = message.user ?? "";
      const isBot = message.bot_id !== undefined;
      const name = userId
        ? await nameOf(userId)
        : (message.bot_profile?.name ?? message.username ?? "bot");
      return {
        userId,
        name,
        isBot,
        text: unescapeSlack((message.text ?? "").trim()),
        fileNames: (message.files ?? []).map((file) => file.name ?? "file"),
      };
    }),
  );
}

export function toInboundEvent(
  thread: Pick<Thread, "id">,
  message: Pick<Message, "id" | "text" | "author" | "attachments">,
  kind: InboundEvent["kind"],
  botNames: ReadonlyArray<string>,
  mentions: ReadonlyArray<MentionedUser> = [],
  earlierMessages?: InboundEvent["earlierMessages"],
): InboundEvent {
  // Chat SDK Slack thread ids are `slack:<channel>:<thread ts>`.
  const channelId = thread.id.split(":")[1] ?? "";
  return {
    eventId: `slack:${channelId}:${message.id}`,
    chatThreadKey: thread.id,
    channelId,
    messageId: message.id,
    kind,
    author: {
      userId: message.author.userId,
      userName: message.author.userName,
      fullName: message.author.fullName,
    },
    text: stripBotMention(message.text, botNames),
    files: message.attachments.map(toInboundFile),
    mentions,
    ...(earlierMessages ? { earlierMessages } : {}),
  };
}

export async function startSlackChatHost(options: SlackChatHostOptions): Promise<SlackChatHost> {
  const slack: SlackAdapter = createSlackAdapter({
    mode: "socket",
    botToken: options.botToken,
    appToken: options.appToken,
    // The adapter falls back to SLACK_SIGNING_SECRET; Socket Mode does not use it.
    signingSecret: "",
    ...(options.botUserId ? { botUserId: options.botUserId } : {}),
    ...(options.apiUrl
      ? { apiUrl: options.apiUrl, webClientOptions: { retryConfig: { retries: 0 } } }
      : {}),
    logger: options.log ? redactingLogger(options.log) : quietLogger,
  });
  const chat = new Chat({
    userName: "t3",
    adapters: { slack },
    state: options.state,
    // A handler only hands a message to T3, so queueing behind the thread lock
    // costs little and keeps a quick follow-up from racing the first mention's binding.
    concurrency: "queue",
    logger: "warn",
  });

  // The adapter caches user lookups in state, so this costs one Slack call per
  // cache period. A failed lookup renders the mention as the bare user id.
  const botMentionNames = async (): Promise<ReadonlyArray<string>> => {
    const botUserId = slack.botUserId;
    if (!botUserId) return [slack.userName];
    const self = await slack.getUser(botUserId);
    return [self?.userName ?? "", slack.userName, botUserId];
  };

  // Slack text names people by display name only; the agent needs their ids to mention them back.
  const mentionedUsers = async (message: Message): Promise<Array<MentionedUser>> => {
    const raw = message.raw as { readonly text?: unknown } | undefined;
    const ids = mentionedUserIds(raw?.text, slack.botUserId);
    return Promise.all(
      ids.map(async (userId) => {
        const user = await slack.getUser(userId).catch(() => null);
        return { userId, name: user?.fullName || user?.userName || userId };
      }),
    );
  };

  const nameOf = async (userId: string) => {
    const user = await slack.getUser(userId).catch(() => null);
    return user?.fullName || user?.userName || userId;
  };

  // A long thread spans pages; past this many the oldest are dropped anyway.
  const HISTORY_PAGES = 5;
  /** The thread's messages before `messageId`, when that message is a reply in a thread. */
  const earlierInThread = (chatThreadKey: string, messageId: string) => {
    const { channel, threadTs } = slack.decodeThreadId(chatThreadKey);
    if (!threadTs || !tsBefore(threadTs, messageId)) return undefined;
    return async () => {
      const raw: Array<SlackRawMessage> = [];
      let cursor: string | undefined;
      for (let page = 0; page < HISTORY_PAGES; page++) {
        const result = await slack.webClient.conversations.replies({
          channel,
          ts: threadTs,
          latest: messageId,
          inclusive: false,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        raw.push(...((result.messages ?? []) as Array<SlackRawMessage>));
        cursor = result.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
      return toEarlierMessages(raw, messageId, nameOf);
    };
  };

  const deliver = async (
    thread: Thread,
    message: Message,
    context: MessageContext | undefined,
    kind: InboundEvent["kind"],
  ) => {
    let bound = false;
    const botNames = await botMentionNames();
    // The queue strategy hands over only the latest message; earlier ones arrive as `skipped`.
    for (const each of [...(context?.skipped ?? []), message]) {
      if (each.author.isMe || each.author.isBot === true) continue;
      const mentions = await mentionedUsers(each);
      const earlier = kind === "mention" ? earlierInThread(thread.id, each.id) : undefined;
      const outcome = await options.onEvent(
        toInboundEvent(thread, each, kind, botNames, mentions, earlier),
      );
      if (outcome.type === "started" || outcome.type === "followed_up") bound = true;
    }
    if (bound && kind === "mention") await thread.subscribe();
  };
  const guarded =
    (kind: InboundEvent["kind"]) =>
    async (thread: Thread, message: Message, context?: MessageContext) => {
      try {
        await deliver(thread, message, context, kind);
      } catch (error) {
        options.onError(error);
      }
    };
  chat.onNewMention(guarded("mention"));
  chat.onSubscribedMessage(guarded("follow_up"));

  await chat.initialize();
  const mrkdwn = new SlackFormatConverter();

  return {
    post: async (message) => {
      const files = message.files ?? [];
      if (files.length === 0) {
        await chat.thread(message.chatThreadKey).post({ markdown: message.text });
        return;
      }
      // The SDK uploads files and posts the text as two messages. Slack's
      // `initial_comment` puts the text on the file message itself, in mrkdwn.
      const { channel, threadTs } = slack.decodeThreadId(message.chatThreadKey);
      const comment =
        message.text.trim() === "" ? "" : mrkdwn.toResponseUrlText({ markdown: message.text });
      await slack.webClient.files.uploadV2({
        channel_id: channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(comment ? { initial_comment: comment } : {}),
        file_uploads: files.map((file) => ({ file: file.data, filename: file.filename })),
      });
    },
    react: async ({ chatThreadKey, messageId, emoji }) => {
      const { channel, threadTs } = slack.decodeThreadId(chatThreadKey);
      // Slack returns the thread's parent plus the reply at `messageId`, if the thread has one.
      const replies = await slack.webClient.conversations.replies({
        channel,
        ts: threadTs,
        oldest: messageId,
        latest: messageId,
        inclusive: true,
        limit: 2,
      });
      if (!replies.messages?.some((reply) => reply.ts === messageId)) {
        throw new Error(`Message ${messageId} is not in this Slack thread.`);
      }
      try {
        await slack.webClient.reactions.add({ channel, timestamp: messageId, name: emoji });
      } catch (error) {
        if ((error as { data?: { error?: string } }).data?.error !== "already_reacted") throw error;
      }
    },
    shutdown: () => chat.shutdown(),
  };
}

const LOG_LINE_LIMIT = 500;

/** Removes Slack tokens and Socket Mode connection tickets from a log line. */
export function redactSlackSecrets(text: string): string {
  return text
    .replace(/\b(?:xox[a-z]|xapp)-[A-Za-z0-9-]+/g, "<redacted>")
    .replace(/ticket=[^&\s"']+/g, "ticket=<redacted>");
}

const describe = (value: unknown): string => {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, (_key, inner: unknown) =>
      inner instanceof Error ? `${inner.name}: ${inner.message}` : inner,
    );
  } catch {
    return String(value);
  }
};

function redactingLogger(log: NonNullable<SlackChatHostOptions["log"]>): Logger {
  const line =
    (level: "info" | "warn" | "error") =>
    (message: string, ...args: Array<unknown>) =>
      log(
        level,
        redactSlackSecrets([message, ...args.map(describe)].join(" ")).slice(0, LOG_LINE_LIMIT),
      );
  const logger: Logger = {
    debug: () => {},
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
    child: () => logger,
  };
  return logger;
}

const noop = () => {};
/** The adapter's own logger prints request details; the bridge reports failures itself. */
const quietLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => quietLogger,
};
