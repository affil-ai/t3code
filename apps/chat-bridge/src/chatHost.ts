/**
 * The one Chat SDK `Chat` the bridge runs, with an adapter per platform
 * (Slack, iMessage, …). The SDK does dedupe, thread locks, queueing and
 * subscriptions for all of them; each platform only turns its SDK messages
 * into `InboundEvent`s (`Deliver`) and adds what the SDK has no API for.
 */
import {
  type Adapter,
  Chat,
  type Message,
  type MessageContext,
  type StateAdapter,
  type Thread,
} from "chat";

import type { InboundReaction } from "./bridge.ts";
import { ANSWER_ACTION_ID } from "./questions.ts";

/** How the SDK routed a message: a new mention, a reply in a followed thread, or a direct message. */
export type Route = "mention" | "subscribed" | "direct";

/** Hands one SDK message, and any the queue skipped before it, to the bridge. */
export type Deliver = (
  thread: Thread,
  message: Message,
  context: MessageContext | undefined,
  route: Route,
) => Promise<void>;

export interface ChatHostOptions {
  /** By adapter name, such as `{ slack, imessage }`; thread ids start with the name. */
  readonly adapters: Readonly<Record<string, Adapter>>;
  /** Each adapter's own conversion, by the same name. */
  readonly deliver: Readonly<Record<string, Deliver>>;
  readonly state: StateAdapter;
  readonly onError: (error: unknown) => void;
  /** Someone pressed a platform's stop control on a thread. */
  readonly onStop?: ((chatThreadKey: string, userId: string) => Promise<unknown>) | undefined;
  /** Someone pressed an answer button under a question; `value` is the button's. */
  readonly onAnswer?:
    | ((chatThreadKey: string, userId: string, value: string) => Promise<unknown>)
    | undefined;
  /** Someone added or removed a reaction on a message, on any platform. */
  readonly onReaction?: ((reaction: InboundReaction) => Promise<unknown>) | undefined;
  readonly log: (line: string) => void;
}

/** A Chat SDK reaction as the core takes it. */
export function toInboundReaction(event: {
  readonly threadId: string;
  readonly messageId: string;
  readonly emoji: { readonly name: string };
  readonly rawEmoji: string;
  readonly added: boolean;
  readonly raw: unknown;
  readonly user: { readonly userId: string; readonly userName: string; readonly fullName: string };
}): InboundReaction {
  const guid = (event.raw as { readonly guid?: unknown } | undefined)?.guid;
  return {
    // An iMessage tapback is its own row with a guid; others are named by what they change.
    eventId:
      typeof guid === "string"
        ? `reaction:${guid}`
        : `reaction:${event.threadId}:${event.messageId}:${event.user.userId}:${event.emoji.name}:${event.added ? "add" : "remove"}`,
    chatThreadKey: event.threadId,
    messageId: event.messageId,
    author: {
      userId: event.user.userId,
      userName: event.user.userName,
      fullName: event.user.fullName,
    },
    emoji: event.emoji.name,
    rawEmoji: event.rawEmoji,
    added: event.added,
  };
}

export async function startChatHost(options: ChatHostOptions): Promise<Chat> {
  const chat = new Chat({
    userName: "t3",
    adapters: { ...options.adapters },
    state: options.state,
    // Every message reaches the core at once, so one that arrives during a run
    // steers it. The core keeps each conversation's messages in order itself; a
    // thread lock here would hold them back, and its queue drops what waits too long.
    concurrency: "concurrent",
    logger: "warn",
  });

  const guarded =
    (route: Route) => async (thread: Thread, message: Message, context?: MessageContext) => {
      const deliver = options.deliver[thread.adapter.name];
      if (deliver === undefined) return;
      try {
        await deliver(thread, message, context, route);
      } catch (error) {
        options.onError(error);
      }
    };
  // Subscribe as the mention arrives: a quick second message then reaches the core
  // as a follow-up, which the core handles after the mention's binding.
  chat.onNewMention(async (thread, message, context) => {
    await thread.subscribe().catch((error: unknown) => options.onError(error));
    await guarded("mention")(thread, message, context);
  });
  chat.onSubscribedMessage(guarded("subscribed"));
  chat.onDirectMessage((thread, message, _channel, context) =>
    guarded("direct")(thread, message, context),
  );

  chat.onAgentSessionStopped(async (event) => {
    try {
      await options.onStop?.(event.threadId, event.userId);
    } catch (error) {
      options.onError(error);
    }
  });
  chat.onAppContextChanged((event) => {
    options.log(
      `app_context_changed from ${event.userId} (${event.entities.length} entities); ignored.`,
    );
  });
  chat.onReaction(async (event) => {
    if (event.user.isMe || event.user.isBot === true) return;
    try {
      await options.onReaction?.(toInboundReaction(event));
    } catch (error) {
      options.onError(error);
    }
  });
  chat.onAction(async (event) => {
    if (!event.actionId.startsWith(ANSWER_ACTION_ID)) return;
    try {
      await options.onAnswer?.(event.threadId, event.user.userId, event.value ?? "");
    } catch (error) {
      options.onError(error);
    }
  });

  await chat.initialize();
  return chat;
}
