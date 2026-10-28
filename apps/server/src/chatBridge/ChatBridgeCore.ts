/**
 * The T3 side of the chat bridge. It knows nothing about the Chat SDK: a
 * platform host hands it normalized inbound events and posts the replies it
 * returns. It decides who may start work, where a chat thread's work goes,
 * and which run answers which chat thread.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2Run,
  type ProjectId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ChatBindingStore from "./ChatBindingStore.ts";
import * as ChatBridgeConfigStore from "./ChatBridgeConfigStore.ts";

export interface ChatAuthor {
  readonly userId: string;
  readonly userName: string;
  readonly fullName: string;
}

/** One chat message addressed to the bot, after the host has dropped its own and other bots' messages. */
export interface ChatInboundEvent {
  /** Unique per chat message; it keys the T3 command, so a redelivery cannot start a second turn. */
  readonly eventId: string;
  readonly platform: "slack";
  /** The Chat SDK thread id, such as `slack:C0123:1700000000.000100`. */
  readonly chatThreadKey: string;
  readonly channelId: string;
  /** A mention outside a bound thread starts one; anything in a bound thread follows up. */
  readonly kind: "mention" | "follow_up";
  readonly author: ChatAuthor;
  readonly text: string;
  /** Step 1 does not import files; their names go into the turn so the agent knows they exist. */
  readonly fileNames: ReadonlyArray<string>;
}

export type ChatInboundOutcome =
  | { readonly type: "started"; readonly threadId: ThreadId }
  | { readonly type: "queued"; readonly threadId: ThreadId }
  | {
      readonly type: "ignored";
      readonly reason: "disabled" | "not_allowed" | "unmapped_channel" | "unbound_thread";
    };

export interface ChatOutboundReply {
  readonly chatThreadKey: string;
  readonly runId: RunId;
  readonly text: string;
}

/** The T3 thread operations the bridge needs. The live layer adapts orchestration to it. */
export class ChatThreads extends Context.Service<
  ChatThreads,
  {
    readonly start: (input: {
      readonly commandId: CommandId;
      readonly messageId: MessageId;
      readonly projectId: ProjectId;
      readonly title: string;
      readonly text: string;
    }) => Effect.Effect<ThreadId, ChatThreadsError>;
    /** Adds the message behind any run in flight, so chat follow-ups never steer one. */
    readonly queue: (input: {
      readonly commandId: CommandId;
      readonly messageId: MessageId;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<void, ChatThreadsError>;
    /** The root agent's last assistant message in the run. */
    readonly finalAnswer: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly run: OrchestrationV2Run;
    }) => Effect.Effect<Option.Option<string>, ChatThreadsError>;
  }
>()("t3/chatBridge/ChatBridgeCore/ChatThreads") {}

export class ChatThreadsError extends Data.TaggedError("ChatThreadsError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type ChatBridgeCoreError =
  | ChatThreadsError
  | ChatBindingStore.ChatBindingStoreError
  | ChatBridgeConfigStore.ChatBridgeConfigError;

/** Marks the user messages the bridge sent, so only their runs answer back to chat. */
export const CHAT_MESSAGE_PREFIX = "chat-bridge:";

const TERMINAL_TEXT = {
  failed: "The run failed. Open the thread in T3 Code for details.",
  cancelled: "The run was stopped.",
  interrupted: "The run was stopped.",
  rolled_back: "The run was rolled back.",
} as const;

const TITLE_LIMIT = 80;

export function turnText(event: ChatInboundEvent): string {
  const lines = [
    `Slack message from ${event.author.fullName || event.author.userName} (${event.author.userId}):`,
    "",
    event.text,
  ];
  if (event.fileNames.length > 0) {
    lines.push("", `Attached in Slack but not imported: ${event.fileNames.join(", ")}`);
  }
  return lines.join("\n");
}

function threadTitle(text: string): string {
  const firstLine = text.trim().split("\n", 1)[0] ?? "";
  if (firstLine === "") return "Slack request";
  return firstLine.length > TITLE_LIMIT ? `${firstLine.slice(0, TITLE_LIMIT - 1)}…` : firstLine;
}

export class ChatBridgeCore extends Context.Service<
  ChatBridgeCore,
  {
    readonly receive: (
      event: ChatInboundEvent,
    ) => Effect.Effect<ChatInboundOutcome, ChatBridgeCoreError>;
    /**
     * The reply a finished run owes its chat thread, claimed so it is returned
     * once. A caller that fails to post it calls `releaseReply`.
     */
    readonly claimReply: (
      run: OrchestrationV2Run,
    ) => Effect.Effect<Option.Option<ChatOutboundReply>, ChatBridgeCoreError>;
    readonly releaseReply: (
      runId: RunId,
    ) => Effect.Effect<void, ChatBindingStore.ChatBindingStoreError>;
  }
>()("t3/chatBridge/ChatBridgeCore") {}

export const make = Effect.gen(function* () {
  const bindings = yield* ChatBindingStore.ChatBindingStore;
  const threads = yield* ChatThreads;
  const config = yield* ChatBridgeConfigStore.ChatBridgeConfigStore;

  const receive = Effect.fn("ChatBridgeCore.receive")(function* (event: ChatInboundEvent) {
    const slack = yield* config.slack;
    if (!slack.enabled) return { type: "ignored", reason: "disabled" } as const;
    if (!slack.allowedUserIds.includes(event.author.userId)) {
      return { type: "ignored", reason: "not_allowed" } as const;
    }
    const commandId = CommandId.make(`${CHAT_MESSAGE_PREFIX}${event.eventId}`);
    const messageId = MessageId.make(`${CHAT_MESSAGE_PREFIX}${event.eventId}`);
    const text = turnText(event);

    const existing = yield* bindings.get(event.chatThreadKey);
    if (Option.isSome(existing)) {
      const binding = existing.value;
      yield* threads.queue({
        commandId,
        messageId,
        projectId: binding.projectId,
        threadId: binding.threadId,
        text,
      });
      return { type: "queued", threadId: binding.threadId } as const;
    }
    if (event.kind === "follow_up") return { type: "ignored", reason: "unbound_thread" } as const;

    const mapping = slack.channelProjects.find((entry) => entry.channelId === event.channelId);
    if (mapping === undefined) return { type: "ignored", reason: "unmapped_channel" } as const;
    // The command id makes a retried launch replay its receipt, so a crash
    // before the binding is saved yields the same thread on redelivery.
    const threadId = yield* threads.start({
      commandId,
      messageId,
      projectId: mapping.projectId,
      title: threadTitle(event.text),
      text,
    });
    yield* bindings.insert({
      chatThreadKey: event.chatThreadKey,
      platform: event.platform,
      channelId: event.channelId,
      projectId: mapping.projectId,
      threadId,
      createdByUserId: event.author.userId,
    });
    return { type: "started", threadId } as const;
  });

  const claimReply = Effect.fn("ChatBridgeCore.claimReply")(function* (run: OrchestrationV2Run) {
    if (!run.userMessageId.startsWith(CHAT_MESSAGE_PREFIX)) return Option.none();
    if (
      run.status !== "completed" &&
      run.status !== "failed" &&
      run.status !== "cancelled" &&
      run.status !== "interrupted" &&
      run.status !== "rolled_back"
    ) {
      return Option.none();
    }
    const binding = yield* bindings.getByThread(run.threadId);
    if (Option.isNone(binding)) return Option.none();
    const claimed = yield* bindings.claimReply(run.id, binding.value.chatThreadKey);
    if (!claimed) return Option.none();
    const text =
      run.status === "completed"
        ? Option.getOrElse(
            yield* threads
              .finalAnswer({ projectId: binding.value.projectId, threadId: run.threadId, run })
              .pipe(Effect.tapError(() => bindings.releaseReply(run.id))),
            () => "The run finished without a reply.",
          )
        : TERMINAL_TEXT[run.status];
    return Option.some({ chatThreadKey: binding.value.chatThreadKey, runId: run.id, text });
  });

  return ChatBridgeCore.of({
    receive,
    claimReply,
    releaseReply: (runId) => bindings.releaseReply(runId),
  });
});

export const layer = Layer.effect(ChatBridgeCore, make);
