/**
 * The Chat SDK side of the bridge for Slack. It owns the `Chat` instance and
 * the Slack adapter, turns SDK messages into `ChatInboundEvent`s for the core,
 * and posts the core's replies. Nothing here touches T3 threads.
 */
import { createSlackAdapter, type SlackAdapter, SlackFormatConverter } from "@chat-adapter/slack";
import type { ChatBridgeSlackTransport } from "@t3tools/contracts";
import {
  Chat,
  type Logger,
  type Message,
  type MessageContext,
  type StateAdapter,
  type Thread,
} from "chat";

import type {
  ChatInboundEvent,
  ChatInboundFile,
  ChatInboundOutcome,
  ChatMentionedUser,
} from "./ChatBridgeCore.ts";

export interface SlackChatHostOptions {
  readonly transport: ChatBridgeSlackTransport;
  readonly botToken: string;
  /** Required for `webhook`. */
  readonly signingSecret?: string | undefined;
  /** Required for `socket`. */
  readonly appToken?: string | undefined;
  readonly state: StateAdapter;
  readonly onEvent: (event: ChatInboundEvent) => Promise<ChatInboundOutcome>;
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

export interface SlackChatHost {
  /** Webhook transport only: Slack's Events API request, signature checked by the adapter. */
  readonly handleWebhook: (request: Request) => Promise<Response>;
  readonly post: (message: SlackOutboundMessage) => Promise<void>;
  /** Resolves once every webhook delivery received so far has been handled. */
  readonly idle: () => Promise<void>;
  /** Finishes in-flight deliveries, then disconnects. */
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

function toInboundFile(attachment: Message["attachments"][number]): ChatInboundFile {
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

export function toInboundEvent(
  thread: Pick<Thread, "id">,
  message: Pick<Message, "id" | "text" | "author" | "attachments">,
  kind: ChatInboundEvent["kind"],
  botNames: ReadonlyArray<string>,
  mentions: ReadonlyArray<ChatMentionedUser> = [],
): ChatInboundEvent {
  // Chat SDK Slack thread ids are `slack:<channel>:<thread ts>`.
  const channelId = thread.id.split(":")[1] ?? "";
  return {
    eventId: `slack:${channelId}:${message.id}`,
    platform: "slack",
    chatThreadKey: thread.id,
    channelId,
    kind,
    author: {
      userId: message.author.userId,
      userName: message.author.userName,
      fullName: message.author.fullName,
    },
    text: stripBotMention(message.text, botNames),
    files: message.attachments.map(toInboundFile),
    mentions,
  };
}

export async function startSlackChatHost(options: SlackChatHostOptions): Promise<SlackChatHost> {
  const slack: SlackAdapter = createSlackAdapter({
    mode: options.transport,
    botToken: options.botToken,
    // The adapter falls back to SLACK_* environment variables; pass every
    // credential explicitly so only the secret store configures it.
    signingSecret: options.signingSecret ?? "",
    ...(options.appToken ? { appToken: options.appToken } : {}),
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
  const mentionedUsers = async (message: Message): Promise<Array<ChatMentionedUser>> => {
    const raw = message.raw as { readonly text?: unknown } | undefined;
    const ids = mentionedUserIds(raw?.text, slack.botUserId);
    return Promise.all(
      ids.map(async (userId) => {
        const user = await slack.getUser(userId).catch(() => null);
        return { userId, name: user?.fullName || user?.userName || userId };
      }),
    );
  };

  const deliver = async (
    thread: Thread,
    message: Message,
    context: MessageContext | undefined,
    kind: ChatInboundEvent["kind"],
  ) => {
    let bound = false;
    const botNames = await botMentionNames();
    // The queue strategy hands over only the latest message; earlier ones arrive as `skipped`.
    for (const each of [...(context?.skipped ?? []), message]) {
      if (each.author.isMe || each.author.isBot === true) continue;
      const mentions = await mentionedUsers(each);
      const outcome = await options.onEvent(toInboundEvent(thread, each, kind, botNames, mentions));
      if (outcome.type === "started" || outcome.type === "followed_up") bound = true;
    }
    if (bound && kind === "mention") await thread.subscribe();
  };
  const guarded =
    (kind: ChatInboundEvent["kind"]) =>
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

  const inFlight = new Set<Promise<unknown>>();
  const idle = async () => {
    while (inFlight.size > 0) await Promise.allSettled(inFlight);
  };

  return {
    handleWebhook: (request) =>
      chat.webhooks.slack(request, {
        waitUntil: (task) => {
          const tracked = Promise.resolve(task)
            .catch(options.onError)
            .finally(() => inFlight.delete(tracked));
          inFlight.add(tracked);
        },
      }),
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
    idle,
    shutdown: async () => {
      await idle();
      await chat.shutdown();
    },
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
