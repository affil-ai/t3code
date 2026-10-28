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
}

export interface SlackChatHost {
  /** Webhook transport only: Slack's Events API request, signature checked by the adapter. */
  readonly handleWebhook: (request: Request) => Promise<Response>;
  readonly post: (reply: ChatOutboundReply) => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Drops the leading `@bot` the user typed to address the bot; other mentions stay. */
export function stripBotMention(text: string, botName: string | undefined): string {
  if (!botName) return text.trim();
  return text.replace(new RegExp(`^\\s*@${escapeRegExp(botName)}\\b[,:]?\\s*`, "i"), "").trim();
}

export function toInboundEvent(
  thread: Pick<Thread, "id">,
  message: Pick<Message, "id" | "text" | "author" | "attachments">,
  kind: ChatInboundEvent["kind"],
  botName: string | undefined,
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
    text: stripBotMention(message.text, botName),
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

  const deliver = async (
    thread: Thread,
    message: Message,
    context: MessageContext | undefined,
    kind: ChatInboundEvent["kind"],
  ) => {
    let bound = false;
    // The queue strategy hands over only the latest message; earlier ones arrive as `skipped`.
    for (const each of [...(context?.skipped ?? []), message]) {
      if (each.author.isMe || each.author.isBot === true) continue;
      const outcome = await options.onEvent(toInboundEvent(thread, each, kind, slack.userName));
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

  return {
    handleWebhook: (request) =>
      chat.webhooks.slack(request, {
        waitUntil: (task) => {
          void Promise.resolve(task).catch(options.onError);
        },
      }),
    post: async (reply) => {
      await chat.thread(reply.chatThreadKey).post({ markdown: reply.text });
    },
    shutdown: () => chat.shutdown(),
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
