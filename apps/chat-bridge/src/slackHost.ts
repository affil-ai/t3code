// @effect-diagnostics globalFetch:off -- A plain Node app; it does not use Effect.
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

import type {
  EarlierMessage,
  EventFile,
  InboundEvent,
  InboundOutcome,
  MentionedUser,
  MissedRequest,
} from "./bridge.ts";
import { withoutAttribution, withRichContent } from "./slackText.ts";
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
  /**
   * Shows a status under the thread, such as "is working…", through
   * `assistant.threads.setStatus` (scope `assistant:write`). Empty clears it.
   * Without the scope it does nothing after the first refusal.
   */
  readonly setStatus: (chatThreadKey: string, status: string) => Promise<void>;
  /** The thread's messages before `messageId`, oldest first; none when the message starts the thread. */
  readonly history: (chatThreadKey: string, messageId: string) => Promise<Array<EarlierMessage>>;
  /** Downloads a Slack file with the bot's token. */
  readonly download: (url: string) => Promise<Uint8Array>;
  /** Follows a channel thread, so its replies arrive without a mention. */
  readonly follow: (chatThreadKey: string) => Promise<void>;
  /**
   * Messages sent since `since`, oldest first: replies in the bound threads,
   * and new top-level messages in the channels (mentions of the bot, or any
   * message in a direct-message channel).
   */
  readonly missedEvents: (request: MissedRequest) => Promise<Array<InboundEvent>>;
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

/** The fields of a Slack `conversations.replies` message the bridge reads. */
export interface SlackRawMessage {
  readonly ts?: string | undefined;
  readonly user?: string | undefined;
  readonly bot_id?: string | undefined;
  readonly username?: string | undefined;
  readonly bot_profile?: { readonly name?: string | undefined } | undefined;
  readonly text?: string | undefined;
  /** Block Kit and legacy attachments, read by `withRichContent`. */
  readonly blocks?: unknown;
  readonly attachments?: unknown;
  readonly files?:
    | ReadonlyArray<{
        readonly name?: string | undefined;
        readonly mimetype?: string | undefined;
        readonly size?: number | undefined;
        readonly url_private_download?: string | undefined;
      }>
    | undefined;
}

function isSlackFileUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return protocol === "https:" && (hostname === "slack.com" || hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
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
 * `download` fetches a file's private URL with the bot's token.
 */
export async function toEarlierMessages(
  raw: ReadonlyArray<SlackRawMessage>,
  beforeTs: string,
  nameOf: (userId: string) => Promise<string>,
  download: (url: string) => Promise<Uint8Array>,
): Promise<Array<EarlierMessage>> {
  const earlier = raw
    .filter((message) => tsBefore(message.ts, beforeTs))
    .filter(
      (message) =>
        (message.text ?? "").trim() !== "" ||
        (message.files ?? []).length > 0 ||
        withRichContent("", message) !== "",
    )
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
        text: withoutAttribution(
          withRichContent(unescapeSlack((message.text ?? "").trim()), message),
        ),
        files: (message.files ?? []).map((file): InboundFile => {
          const url = file.url_private_download;
          return {
            name: file.name ?? "file",
            mimeType: file.mimetype,
            sizeBytes: file.size,
            // A deleted or hidden file has no download link.
            fetch: url ? () => download(url) : undefined,
          };
        }),
      };
    }),
  );
}

/**
 * The thread a message belongs to. Slack gives every top-level direct message
 * the same thread id, `slack:D…:`, so each becomes its own thread, keyed by its ts.
 */
export function chatThreadKeyOf(threadId: string, messageId: string): string {
  return /^slack:D[A-Z0-9]+:$/.test(threadId) ? `${threadId}${messageId}` : threadId;
}

/** The files uploaded with a raw Slack message. A deleted or hidden file has no download link. */
function eventFiles(raw: unknown): Array<EventFile> {
  const files = (raw as SlackRawMessage | undefined)?.files ?? [];
  return files.map((file) => ({
    name: file.name ?? "file",
    mimeType: file.mimetype,
    sizeBytes: file.size,
    url: file.url_private_download,
  }));
}

export function toInboundEvent(
  thread: Pick<Thread, "id">,
  message: Pick<Message, "id" | "text" | "author" | "raw">,
  options: {
    readonly kind: InboundEvent["kind"];
    readonly addressed: boolean;
    readonly botNames: ReadonlyArray<string>;
    readonly mentions?: ReadonlyArray<MentionedUser> | undefined;
    readonly forAnotherBot?: boolean | undefined;
  },
): InboundEvent {
  // Chat SDK Slack thread ids are `slack:<channel>:<thread ts>`.
  const channelId = thread.id.split(":")[1] ?? "";
  return {
    eventId: `slack:${channelId}:${message.id}`,
    chatThreadKey: chatThreadKeyOf(thread.id, message.id),
    channelId,
    messageId: message.id,
    kind: options.kind,
    addressed: options.addressed,
    direct: channelId.startsWith("D"),
    ...(options.forAnotherBot ? { forAnotherBot: true } : {}),
    author: {
      userId: message.author.userId,
      userName: message.author.userName,
      fullName: message.author.fullName,
    },
    text: withoutAttribution(
      withRichContent(stripBotMention(message.text, options.botNames), message.raw),
    ),
    files: eventFiles(message.raw),
    mentions: options.mentions ?? [],
  };
}

/** Slack refuses `markdown_text` over 12,000 characters, so a longer message goes out in parts. */
const SLACK_MARKDOWN_LIMIT = 12_000;
/** Room in a part for a code fence closed at its end and reopened in the next. */
const FENCE_ROOM = 100;
const FENCE = /^\s*```/;

/**
 * Splits markdown into parts Slack accepts, at line breaks. A code block cut
 * in two is closed at the end of one part and reopened in the next.
 */
export function splitMarkdown(text: string, limit = SLACK_MARKDOWN_LIMIT): Array<string> {
  if (text.length <= limit) return [text];
  const lineLimit = limit - 2 * FENCE_ROOM;
  const lines = text.split("\n").flatMap((line) => {
    if (line.length <= lineLimit) return [line];
    const pieces: Array<string> = [];
    for (let at = 0; at < line.length; at += lineLimit) pieces.push(line.slice(at, at + lineLimit));
    return pieces;
  });
  const parts: Array<string> = [];
  let current: Array<string> = [];
  let size = 0;
  let fence: string | undefined;
  for (const line of lines) {
    const closing = fence === undefined ? 0 : 4;
    if (current.length > 0 && size + 1 + line.length + closing > limit) {
      parts.push([...current, ...(fence === undefined ? [] : ["```"])].join("\n"));
      current = fence === undefined ? [] : [fence];
      size = fence?.length ?? 0;
    }
    size += (current.length > 0 ? 1 : 0) + line.length;
    current.push(line);
    if (FENCE.test(line))
      fence = fence === undefined ? line.trim().slice(0, FENCE_ROOM - 10) : undefined;
  }
  parts.push(current.join("\n"));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
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
  const mentionedUsers = async (
    message: Message,
  ): Promise<Array<MentionedUser & { readonly isBot: boolean }>> => {
    const raw = message.raw as { readonly text?: unknown } | undefined;
    const text = typeof raw?.text === "string" ? withoutAttribution(raw.text) : undefined;
    const ids = mentionedUserIds(text, slack.botUserId);
    return Promise.all(
      ids.map(async (userId) => {
        const user = await slack.getUser(userId).catch(() => null);
        return {
          userId,
          name: user?.fullName || user?.userName || userId,
          isBot: user?.isBot === true,
        };
      }),
    );
  };

  const download = async (url: string) => {
    // The token goes only to Slack; a file link elsewhere is not fetched with it.
    if (!isSlackFileUrl(url)) throw new Error("The file is not hosted by Slack.");
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${options.botToken}` },
    });
    if (!response.ok) throw new Error(`Slack answered ${response.status} for a file download.`);
    return new Uint8Array(await response.arrayBuffer());
  };

  const nameOf = async (userId: string) => {
    const user = await slack.getUser(userId).catch(() => null);
    return user?.fullName || user?.userName || userId;
  };

  // A long thread spans pages; past this many the oldest are dropped anyway.
  const HISTORY_PAGES = 5;
  /** Every page of a Slack history call, up to `HISTORY_PAGES`. */
  const readPages = async (
    read: (cursor: string | undefined) => Promise<{
      readonly messages?: ReadonlyArray<unknown> | undefined;
      readonly response_metadata?: { readonly next_cursor?: string | undefined } | undefined;
    }>,
  ): Promise<Array<SlackRawMessage>> => {
    const raw: Array<SlackRawMessage> = [];
    let cursor: string | undefined;
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const result = await read(cursor);
      raw.push(...((result.messages ?? []) as Array<SlackRawMessage>));
      cursor = result.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return raw;
  };

  const history = async (chatThreadKey: string, messageId: string) => {
    const { channel, threadTs } = slack.decodeThreadId(chatThreadKey);
    if (!threadTs || !tsBefore(threadTs, messageId)) return [];
    const raw = await readPages((cursor) =>
      slack.webClient.conversations.replies({
        channel,
        ts: threadTs,
        latest: messageId,
        inclusive: false,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      }),
    );
    return toEarlierMessages(raw, messageId, nameOf, download);
  };

  /** One message as an inbound event, or nothing for the bot's own and other bots' messages. */
  const eventOf = async (
    threadId: string,
    message: Message,
    kind: InboundEvent["kind"],
    addressed: boolean,
    botNames: ReadonlyArray<string>,
  ): Promise<InboundEvent | undefined> => {
    if (message.author.isMe || message.author.isBot === true) return undefined;
    const mentions = await mentionedUsers(message);
    return toInboundEvent({ id: threadId }, message, {
      kind,
      addressed,
      botNames,
      mentions: mentions.map(({ userId, name }) => ({ userId, name })),
      forAnotherBot: !addressed && mentions.some((user) => user.isBot),
    });
  };

  type Route = "mention" | "subscribed" | "direct";
  const deliver = async (
    thread: Thread,
    message: Message,
    context: MessageContext | undefined,
    route: Route,
  ) => {
    const botNames = await botMentionNames();
    // In a direct message every message is addressed and may start a thread.
    const kind = route === "subscribed" ? "follow_up" : "mention";
    // The queue strategy hands over only the latest message; earlier ones arrive as `skipped`.
    for (const each of [...(context?.skipped ?? []), message]) {
      const addressed = route !== "subscribed" || each.isMention === true;
      const event = await eventOf(thread.id, each, kind, addressed, botNames);
      if (event !== undefined) await options.onEvent(event);
    }
  };

  /** A message read back from Slack, parsed as the adapter parses live ones, with its author's name. */
  const parsed = async (channel: string, raw: SlackRawMessage) => {
    const message = slack.parseMessage({ ...raw, channel } as Parameters<
      SlackAdapter["parseMessage"]
    >[0]);
    const userId = message.author.userId;
    const user = raw.user ? await slack.getUser(userId).catch(() => null) : null;
    if (user) {
      message.author = {
        ...message.author,
        userName: user.userName || userId,
        fullName: user.fullName || user.userName || userId,
      };
    }
    return message;
  };

  const missedEvents = async (request: MissedRequest) => {
    const oldest = (request.since / 1000).toFixed(6);
    const botNames = await botMentionNames();
    const events: Array<InboundEvent> = [];
    for (const chatThreadKey of request.threads) {
      const { channel, threadTs } = slack.decodeThreadId(chatThreadKey);
      if (!threadTs) continue;
      const replies = await readPages((cursor) =>
        slack.webClient.conversations.replies({
          channel,
          ts: threadTs,
          oldest,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const raw of replies) {
        if (raw.ts === undefined || raw.ts === threadTs || Number(raw.ts) < Number(oldest))
          continue;
        const message = await parsed(channel, raw);
        const addressed = channel.startsWith("D") || message.isMention === true;
        const event = await eventOf(chatThreadKey, message, "follow_up", addressed, botNames);
        if (event !== undefined) events.push(event);
      }
    }
    for (const channel of request.channels) {
      const direct = channel.startsWith("D");
      const recent = await readPages((cursor) =>
        slack.webClient.conversations.history({
          channel,
          oldest,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        }),
      );
      for (const raw of recent) {
        // Replies in threads the bot follows are read above; this looks for new threads only.
        const threadTs = (raw as { readonly thread_ts?: string }).thread_ts;
        if (raw.ts === undefined || (threadTs !== undefined && threadTs !== raw.ts)) continue;
        const message = await parsed(channel, raw);
        if (!direct && message.isMention !== true) continue;
        const threadId = `slack:${channel}:${raw.ts}`;
        const event = await eventOf(threadId, message, "mention", true, botNames);
        if (event !== undefined) events.push(event);
      }
    }
    return events.toSorted((a, b) => Number(a.messageId) - Number(b.messageId));
  };
  const guarded =
    (route: Route) => async (thread: Thread, message: Message, context?: MessageContext) => {
      try {
        await deliver(thread, message, context, route);
      } catch (error) {
        options.onError(error);
      }
    };
  chat.onNewMention(guarded("mention"));
  chat.onSubscribedMessage(guarded("subscribed"));
  chat.onDirectMessage((thread, message, _channel, context) =>
    guarded("direct")(thread, message, context),
  );

  await chat.initialize();
  let statusUnavailable = false;
  const mrkdwn = new SlackFormatConverter();

  return {
    post: async (message) => {
      const files = message.files ?? [];
      const parts = splitMarkdown(message.text);
      // Every part but the last goes alone; the last carries the files, if any.
      const last = parts.pop() ?? "";
      for (const part of parts) await chat.thread(message.chatThreadKey).post({ markdown: part });
      if (files.length === 0) {
        if (last !== "") await chat.thread(message.chatThreadKey).post({ markdown: last });
        return;
      }
      // The SDK uploads files and posts the text as two messages. Slack's
      // `initial_comment` puts the text on the file message itself, in mrkdwn.
      const { channel, threadTs } = slack.decodeThreadId(message.chatThreadKey);
      const comment = last.trim() === "" ? "" : mrkdwn.toResponseUrlText({ markdown: last });
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
    setStatus: async (chatThreadKey, status) => {
      if (statusUnavailable) return;
      const { channel, threadTs } = slack.decodeThreadId(chatThreadKey);
      if (!threadTs) return;
      try {
        await slack.webClient.apiCall("assistant.threads.setStatus", {
          channel_id: channel,
          thread_ts: threadTs,
          status,
        });
      } catch (error) {
        const code = (error as { data?: { error?: string } }).data?.error;
        if (code === "missing_scope" || code === "not_allowed_token_type") {
          statusUnavailable = true;
          options.log?.(
            "warn",
            `Thread status is off: Slack answered ${code}. Add the assistant:write scope to show it.`,
          );
          return;
        }
        throw error;
      }
    },
    history,
    download,
    follow: async (chatThreadKey) => {
      // Direct messages all reach the bot anyway; a channel thread needs following.
      if (slack.decodeThreadId(chatThreadKey).channel.startsWith("D")) return;
      await chat.thread(chatThreadKey).subscribe();
    },
    missedEvents,
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
