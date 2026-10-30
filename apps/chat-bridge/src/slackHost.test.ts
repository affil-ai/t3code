import { assert, it } from "vite-plus/test";

import {
  chatThreadKeyOf,
  mentionedUserIds,
  redactSlackSecrets,
  splitMarkdown,
  stripBotMention,
  toEarlierMessages,
  toInboundEvent,
} from "./slackHost.ts";

it("strips only the leading bot mention", () => {
  assert.strictEqual(stripBotMention("@t3 fix it", ["t3"]), "fix it");
  assert.strictEqual(stripBotMention("@T3: fix it", ["t3"]), "fix it");
  assert.strictEqual(stripBotMention("ask @t3 later", ["t3"]), "ask @t3 later");
  assert.strictEqual(stripBotMention("@t3bot hi", ["t3"]), "@t3bot hi");
  // Slack renders the mention with the bot's display name, or its id when the lookup failed.
  assert.strictEqual(stripBotMention("@[Dev] Affil what?", ["[Dev] Affil", "dev-affil"]), "what?");
  assert.strictEqual(stripBotMention("@U0BOT hi", ["", "t3", "U0BOT"]), "hi");
});

it("maps a Chat SDK message to an inbound event", () => {
  const event = toInboundEvent(
    { id: "slack:C0MAPPED:1700000000.000100" },
    {
      id: "1700000000.000200",
      text: "@t3 also the lint",
      author: { userId: "U1", userName: "ada", fullName: "Ada", isBot: false, isMe: false },
      raw: {
        files: [{ name: "trace.log", url_private_download: "https://files.slack.com/trace.log" }],
      },
    },
    {
      kind: "follow_up",
      addressed: true,
      botNames: ["t3"],
      mentions: [{ userId: "U2", name: "Grace" }],
    },
  );
  const { files, ...rest } = event;
  assert.deepStrictEqual(rest, {
    eventId: "slack:C0MAPPED:1700000000.000200",
    chatThreadKey: "slack:C0MAPPED:1700000000.000100",
    channelId: "C0MAPPED",
    messageId: "1700000000.000200",
    kind: "follow_up",
    addressed: true,
    direct: false,
    author: { userId: "U1", userName: "ada", fullName: "Ada" },
    text: "also the lint",
    mentions: [{ userId: "U2", name: "Grace" }],
  });
  assert.deepStrictEqual(files, [
    {
      name: "trace.log",
      mimeType: undefined,
      sizeBytes: undefined,
      url: "https://files.slack.com/trace.log",
    },
  ]);
});

it("reads mentioned user ids from Slack's raw text, without the bot", () => {
  assert.deepStrictEqual(
    mentionedUserIds("<@U0BOT> ask <@U0GRACE|grace> and <@U0ADA>, then <@U0GRACE>", "U0BOT"),
    ["U0GRACE", "U0ADA"],
  );
  assert.deepStrictEqual(mentionedUserIds(undefined, "U0BOT"), []);
});

it("redacts Slack tokens and socket tickets", () => {
  assert.strictEqual(
    redactSlackSecrets(
      "xoxb-123-456-abcDEF and xapp-1-A0-789-ff; wss://x/?ticket=abc-123&app_id=A0",
    ),
    "<redacted> and <redacted>; wss://x/?ticket=<redacted>&app_id=A0",
  );
});

it("reads the thread before a message, oldest first, with names and files", async () => {
  const downloads: Array<string> = [];
  const earlier = await toEarlierMessages(
    [
      { ts: "100.3", user: "U0GRACE", text: "if a &lt; b &amp;&amp; c &gt; d" },
      {
        ts: "100.1",
        user: "U0ADA",
        text: "first <@U0GRACE>",
        files: [
          {
            name: "a.png",
            mimetype: "image/png",
            size: 3,
            url_private_download: "https://files/a",
          },
        ],
      },
      {
        ts: "100.2",
        bot_id: "B1",
        bot_profile: { name: "CI" },
        text: "build failed",
        files: [{ name: "gone" }],
      },
      { ts: "100.4", user: "U0ADA", text: "" },
      { ts: "100.5", user: "U0ADA", text: "the mention itself" },
      { ts: "100.6", user: "U0ADA", text: "after" },
    ],
    "100.5",
    async (userId) => (userId === "U0ADA" ? "Ada" : "Grace"),
    async (url) => {
      downloads.push(url);
      return new Uint8Array([1]);
    },
  );
  assert.deepStrictEqual(
    earlier.map(({ files, ...rest }) => ({ ...rest, files: files.map((file) => file.name) })),
    [
      { userId: "U0ADA", name: "Ada", isBot: false, text: "first <@U0GRACE>", files: ["a.png"] },
      { userId: "", name: "CI", isBot: true, text: "build failed", files: ["gone"] },
      { userId: "U0GRACE", name: "Grace", isBot: false, text: "if a < b && c > d", files: [] },
    ],
  );
  assert.strictEqual(earlier[0]!.files[0]!.mimeType, "image/png");
  await earlier[0]!.files[0]!.fetch!();
  assert.deepStrictEqual(downloads, ["https://files/a"]);
  // A file Slack no longer serves has no download link.
  assert.strictEqual(earlier[1]!.files[0]!.fetch, undefined);
});

it("gives each top-level direct message its own thread", () => {
  assert.strictEqual(chatThreadKeyOf("slack:D0AB:", "300.1"), "slack:D0AB:300.1");
  assert.strictEqual(chatThreadKeyOf("slack:D0AB:300.1", "300.2"), "slack:D0AB:300.1");
  assert.strictEqual(chatThreadKeyOf("slack:C0AB:100.1", "100.2"), "slack:C0AB:100.1");
});

it("splits long markdown at line breaks and keeps code blocks whole", () => {
  assert.deepStrictEqual(splitMarkdown("short"), ["short"]);
  const paragraph = "word ".repeat(30).trim();
  const text = [
    paragraph,
    paragraph,
    "```ts",
    "const a = 1;",
    "const b = 2;",
    "```",
    paragraph,
  ].join("\n");
  const parts = splitMarkdown(text, 300);
  assert.isAbove(parts.length, 1);
  for (const part of parts) {
    assert.isAtMost(part.length, 300);
    // Every part has balanced fences.
    assert.strictEqual((part.match(/```/g) ?? []).length % 2, 0);
  }
  assert.strictEqual(
    parts
      .join("\n")
      .replaceAll(/```(ts)?\n?/g, "")
      .replaceAll(/\s+/g, " "),
    text.replaceAll(/```(ts)?\n?/g, "").replaceAll(/\s+/g, " "),
  );

  const oneLine = "x".repeat(1000);
  // A line too long for one part is cut, so a part may end mid-line.
  assert.strictEqual(splitMarkdown(oneLine, 300).join("").replaceAll("\n", ""), oneLine);
});
