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
  readonly log: (line: string) => void;
}

export async function startChatHost(options: ChatHostOptions): Promise<Chat> {
  const chat = new Chat({
    userName: "t3",
    adapters: { ...options.adapters },
    state: options.state,
    // A handler only hands a message to T3, so queueing behind the thread lock
    // costs little and keeps a quick follow-up from racing the first message's binding.
    concurrency: "queue",
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
  chat.onNewMention(guarded("mention"));
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
