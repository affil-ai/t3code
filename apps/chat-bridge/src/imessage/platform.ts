/**
 * iMessage for the bridge core: its SDK messages as `InboundEvent`s, and the
 * `ChatPlatform` the core posts through. Everything goes through the shared
 * `Chat` and the iMessage adapter; nothing here speaks to the Mac itself.
 */
import type { Chat, Message } from "chat";

import type { EarlierMessage, InboundEvent, InboundOutcome } from "../bridge.ts";
import type { Deliver } from "../chatHost.ts";
import type { Access, ChatPlatform, ThreadRoute } from "../platform.ts";
import type { ImessageAdapter } from "./adapter.ts";

/** Earlier messages a first turn carries, for context in a conversation that started before the bot. */
const HISTORY_LIMIT = 20;

export function imessageEvent(
  threadId: string,
  message: Message,
  kind: InboundEvent["kind"],
): InboundEvent {
  const raw = message.raw as { readonly guid?: string } | undefined;
  return {
    eventId: `imessage:${raw?.guid ?? message.id}`,
    chatThreadKey: threadId,
    channelId: threadId,
    messageId: message.id,
    kind,
    // Every message is for the bot, in groups too; the agent decides whether to answer.
    addressed: true,
    // Each conversation is its own thread, started on the platform's route.
    direct: true,
    author: {
      userId: message.author.userId,
      userName: message.author.userName,
      fullName: message.author.fullName,
    },
    text: message.text,
    files: message.attachments.map((file) => ({
      name: file.name ?? "attachment",
      mimeType: file.mimeType,
      sizeBytes: file.size,
      url: file.url,
    })),
    mentions: [],
  };
}

export function imessagePlatform(options: {
  readonly chat: () => Chat | undefined;
  readonly adapter: ImessageAdapter;
  readonly access: Access;
  readonly route: ThreadRoute;
  readonly onEvent: (event: InboundEvent) => Promise<InboundOutcome>;
}): { readonly platform: ChatPlatform; readonly deliver: Deliver } {
  const chat = () => {
    const running = options.chat();
    if (running === undefined) throw new Error("Chat is not running yet.");
    return running;
  };
  const deliver: Deliver = async (thread, message, context, route) => {
    const kind = route === "subscribed" ? "follow_up" : "mention";
    for (const each of [...(context?.skipped ?? []), message]) {
      if (each.author.isMe) continue;
      await options.onEvent(imessageEvent(thread.id, each, kind));
    }
  };
  const platform: ChatPlatform = {
    id: "imessage",
    name: "iMessage",
    place: "iMessage conversation",
    access: options.access,
    directRoute: options.route,
    person: (userId, name) => (name && name !== userId ? `${name} (${userId})` : userId),
    firstTurnNote: (chatKey, event) =>
      [
        "Your final message in each run is sent to this iMessage conversation as plain text: Markdown is removed, so write plainly and keep it short.",
        "If a message needs no reply, end the run without a final message and nothing is sent.",
        ...(options.adapter.isDM(event.chatThreadKey)
          ? []
          : [
              "This is a group conversation and every message in it reaches you. Answer only when someone is talking to you or you clearly have something to add; otherwise end the run without a final message.",
            ]),
        `To send files, such as images, call the chat_post tool with chatKey "${chatKey}" and their paths in your workspace.`,
        "iMessage has no mentions and the bridge can't send tapbacks, so don't call chat_react here.",
      ].join(" "),
    refusal: (userId) =>
      `Sorry, you can't use this bot yet. Ask whoever runs it to add ${userId} to its allowed iMessage senders.`,
    post: async ({ chatThreadKey, text, files }) => {
      const uploads = (files ?? []).map((file) => ({ data: file.data, filename: file.filename }));
      await chat()
        .thread(chatThreadKey)
        .post(uploads.length > 0 ? { markdown: text, files: uploads } : { markdown: text });
    },
    download: async (path) => new Uint8Array(await options.adapter.readAttachment(path)),
    history: async (chatThreadKey, messageId): Promise<Array<EarlierMessage>> => {
      const { messages } = await options.adapter.fetchMessages(chatThreadKey, {
        limit: HISTORY_LIMIT + 1,
      });
      return messages
        .filter((each) => Number(each.id) < Number(messageId) && each.text.trim() !== "")
        .slice(-HISTORY_LIMIT)
        .map((each) => ({
          userId: each.author.isMe ? "" : each.author.userId,
          name: each.author.isMe ? "this account" : each.author.fullName,
          isBot: each.author.isMe,
          text: each.text,
          // Earlier photos are named, not imported.
          files: [],
        }));
    },
    bound: async (chatThreadKey) => {
      await chat().thread(chatThreadKey).subscribe();
    },
  };
  return { platform, deliver };
}
