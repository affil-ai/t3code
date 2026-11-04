// @effect-diagnostics globalDate:off -- A plain Node app; it does not use Effect.
import { Message, parseMarkdown } from "chat";
import { assert, it } from "vite-plus/test";

import { parseConfig } from "../config.ts";
import { ImessageFormatConverter } from "./adapter.ts";
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
  });
  assert.throws(() => parseConfig({ ...base, imessage: {} }), /projectId/);
});
