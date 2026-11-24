// @effect-diagnostics globalDate:off -- A plain Node app; it does not use Effect.
import { Message, parseMarkdown } from "chat";
import { assert, it } from "vite-plus/test";

import { parseConfig } from "../config.ts";
import { toInboundReaction } from "../chatHost.ts";
import {
  ImessageAdapter,
  ImessageFormatConverter,
  type ImsgMessage,
  reactedGuid,
  tapbackKind,
} from "./adapter.ts";
import { imessageEvent } from "./platform.ts";

it("flattens Markdown to the plain text iMessage shows", () => {
  const text = new ImessageFormatConverter().fromAst(
    parseMarkdown(
      "# Title\n\nSome **bold**, `code` and [the spec](https://example.com/s).\n\n- one\n- two\n\n```ts\nconst a = 1;\n```",
    ),
  );
  assert.strictEqual(
    text,
    "Title\n\nSome bold, code and the spec (https://example.com/s).\n\n• one\n• two\n\nconst a = 1;",
  );
});

it("turns an iMessage into an addressed event in its conversation's thread", () => {
  const message = new Message({
    id: "12",
    threadId: "imessage:2",
    text: "look",
    formatted: parseMarkdown("look"),
    raw: { guid: "G-12" },
    author: {
      userId: "a@example.com",
      userName: "a@example.com",
      fullName: "A",
      isBot: false,
      isMe: false,
    },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [
      { type: "image", name: "IMG_1.jpg", mimeType: "image/jpeg", url: "/p/IMG_1.heic#jpeg" },
    ],
  });
  const event = imessageEvent("imessage:2", message, "mention");
  assert.strictEqual(event.eventId, "imessage:G-12");
  assert.strictEqual(event.chatThreadKey, "imessage:2");
  assert.isTrue(event.addressed && event.direct);
  assert.deepStrictEqual(event.files, [
    { name: "IMG_1.jpg", mimeType: "image/jpeg", sizeBytes: undefined, url: "/p/IMG_1.heic#jpeg" },
  ]);
});

it("reads the imessage block, iMessage only unless services says otherwise", () => {
  const base = { t3Url: "http://127.0.0.1:1", channelProjects: [], allowedUserIds: [] };
  assert.isUndefined(parseConfig(base).imessage);
  const config = parseConfig({
    ...base,
    imessage: { projectId: "p", worktreeFrom: "dev", allowEveryone: true },
  });
  assert.deepStrictEqual(config.imessage, {
    host: "127.0.0.1",
    port: 47821,
    route: { projectId: "p", worktreeFrom: "dev" },
    allowedHandles: [],
    allowEveryone: true,
    services: ["iMessage"],
    startAfterRowId: undefined,
    outboundReactions: false,
  });
  assert.throws(() => parseConfig({ ...base, imessage: {} }), /projectId/);
});

/** An adapter whose Mac connection and Chat are fakes; `answer` decides each RPC result. */
function fakeAdapter(
  answer: (method: string, params: Record<string, unknown>) => unknown,
  options: { readonly outboundReactions?: boolean } = {},
) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const reactions: Array<Record<string, unknown>> = [];
  const logs: Array<string> = [];
  const adapter = new ImessageAdapter({
    host: "127.0.0.1",
    port: 1,
    services: ["iMessage"],
    outboundReactions: options.outboundReactions,
    log: (line) => void logs.push(line),
  });
  const state = new Map<string, unknown>();
  const inside = adapter as unknown as {
    rpc: { call: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
    chat: unknown;
    receive: (raw: ImsgMessage) => Promise<void>;
    checkTapbacks: () => Promise<void>;
  };
  inside.rpc = {
    call: async (method, params = {}) => {
      calls.push([method, params]);
      return answer(method, params);
    },
  };
  inside.chat = {
    getState: () => ({
      get: async (key: string) => state.get(key) ?? null,
      set: async (key: string, value: unknown) => void state.set(key, value),
    }),
    processReaction: async (event: Record<string, unknown>) => void reactions.push(event),
    processMessage: async () => {},
  };
  return { adapter, inside, calls, reactions, logs, state };
}

const chatInfo = { id: 2, service: "iMessage", is_group: false };

it("maps emoji names to iMessage's six tapbacks, and strips a tapback's part prefix", () => {
  assert.strictEqual(tapbackKind("thumbsup"), "like");
  assert.strictEqual(tapbackKind(":heart:"), "love");
  assert.strictEqual(tapbackKind("bangbang"), "emphasis");
  assert.isUndefined(tapbackKind("rocket"));
  assert.strictEqual(reactedGuid("p:0/ABC-1"), "ABC-1");
  assert.strictEqual(reactedGuid("ABC-1"), "ABC-1");
});

it("hands a tapback on a message to the SDK as a reaction, with the target's guid", async () => {
  const { inside, reactions, state } = fakeAdapter((method) =>
    method === "chats.get" ? chatInfo : {},
  );
  await inside.receive({
    id: 30,
    chat_id: 2,
    guid: "R-30",
    sender: "a@example.com",
    is_from_me: false,
    is_reaction: true,
    reaction_type: "love",
    is_reaction_add: true,
    reacted_to_guid: "p:0/M-29",
  });
  // The bot's own tapbacks aren't news.
  await inside.receive({
    id: 31,
    chat_id: 2,
    guid: "R-31",
    is_from_me: true,
    is_reaction: true,
    reaction_type: "like",
    reacted_to_guid: "M-1",
  });
  assert.lengthOf(reactions, 1);
  const event = reactions[0]!;
  assert.strictEqual(event.threadId, "imessage:2");
  assert.strictEqual(event.messageId, "M-29");
  assert.strictEqual((event.emoji as { name: string }).name, "heart");
  assert.strictEqual(event.added, true);
  assert.strictEqual(state.get("imessage:cursor"), 31);
  const inbound = toInboundReaction(event as never);
  assert.strictEqual(inbound.eventId, "reaction:R-30");
  assert.strictEqual(inbound.rawEmoji, "love");
});

it("sends the text with the first file, and doesn't resend an unconfirmed send", async () => {
  let sends = 0;
  const { adapter, calls, logs } = fakeAdapter((method, params) => {
    if (method === "attachment.write") return { path: `/staged/${String(params.name)}` };
    if (method === "send") {
      sends += 1;
      if (sends === 2) throw Object.assign(new Error("uncertain"), { code: -32001 });
      return { id: 40 + sends, guid: `S-${sends}` };
    }
    return {};
  });
  await adapter.postMessage("imessage:2", {
    markdown: "Here **they** are",
    files: [
      { data: Buffer.from("png"), filename: "chart.png" },
      { data: Buffer.from("pdf"), filename: "report.pdf" },
    ],
  });
  assert.deepStrictEqual(
    calls.filter(([method]) => method === "send").map(([, params]) => params),
    [
      { chat_id: 2, file: "/staged/chart.png", text: "Here they are", allow_sms_fallback: false },
      { chat_id: 2, file: "/staged/report.pdf", allow_sms_fallback: false },
    ],
  );
  assert.isTrue(logs.some((line) => line.includes("not retrying")));
});

it("sends tapbacks only when turned on and imsg's private bridge is running", async () => {
  const off = fakeAdapter(() => ({}));
  try {
    await off.adapter.addReaction("imessage:2", "M-1", "thumbsup");
    assert.fail("expected tapbacks to be off");
  } catch (error) {
    assert.include(String(error), "SIP");
  }
  let ready = false;
  const on = fakeAdapter(
    (method) =>
      method === "status" ? { methods: ready ? ["tapback"] : [], bridge: { ready } } : {},
    { outboundReactions: true },
  );
  await on.inside.checkTapbacks();
  assert.isFalse(on.adapter.canReact);
  ready = true;
  await on.inside.checkTapbacks();
  assert.isTrue(on.adapter.canReact);
  await on.adapter.addReaction("imessage:2", "M-1", "thumbsup");
  assert.deepStrictEqual(on.calls.at(-1), [
    "tapback",
    { chat_id: 2, message_guid: "M-1", kind: "like" },
  ]);
});
