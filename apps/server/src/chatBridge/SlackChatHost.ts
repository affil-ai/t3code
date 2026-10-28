/**
 * The Chat SDK side of the bridge for Slack. It owns the `Chat` instance and
 * the Slack adapter, turns SDK messages into `ChatInboundEvent`s for the core,
 * and posts the core's replies. Nothing here touches T3 threads.
 */
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import type { ChatBridgeSlackTransport } from "@t3tools/contracts";
import { Chat, type Message, type MessageContext, type StateAdapter, type Thread } from "chat";

import type { ChatInboundEvent, ChatInboundOutcome, ChatOutboundReply } from "./ChatBridgeCore.ts";

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
  /** Tests supply the bot's user id, which `auth.test` would otherwise return. */
  readonly botUserId?: string | undefined;
}

export interface SlackChatHost {
  /** Webhook transport only: Slack's Events API request, signature checked by the adapter. */
  readonly handleWebhook: (request: Request) => Promise<Response>;
  readonly post: (reply: ChatOutboundReply) => Promise<void>;
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

export function toInboundEvent(
  thread: Pick<Thread, "id">,
  message: Pick<Message, "id" | "text" | "author" | "attachments">,
  kind: ChatInboundEvent["kind"],
  botNames: ReadonlyArray<string>,
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
    fileNames: message.attachments.map((attachment) => attachment.name ?? attachment.type),
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
    logger: quietLogger,
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
      const outcome = await options.onEvent(toInboundEvent(thread, each, kind, botNames));
      if (outcome.type === "started" || outcome.type === "queued") bound = true;
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
    post: async (reply) => {
      await chat.thread(reply.chatThreadKey).post({ markdown: reply.text });
    },
    idle,
    shutdown: async () => {
      await idle();
      await chat.shutdown();
    },
  };
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
