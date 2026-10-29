import { assert, it } from "vite-plus/test";

import {
  mentionedUserIds,
  redactSlackSecrets,
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
      attachments: [{ type: "file", name: "trace.log" }],
    },
    "follow_up",
    ["t3"],
    [{ userId: "U2", name: "Grace" }],
  );
  const { files, ...rest } = event;
  assert.deepStrictEqual(rest, {
    eventId: "slack:C0MAPPED:1700000000.000200",
    chatThreadKey: "slack:C0MAPPED:1700000000.000100",
    channelId: "C0MAPPED",
    messageId: "1700000000.000200",
    kind: "follow_up",
    author: { userId: "U1", userName: "ada", fullName: "Ada" },
    text: "also the lint",
    mentions: [{ userId: "U2", name: "Grace" }],
  });
  assert.deepStrictEqual(
    files.map((file) => file.name),
    ["trace.log"],
  );
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

it("reads the thread before a message, oldest first, with names", async () => {
  const earlier = await toEarlierMessages(
    [
      { ts: "100.3", user: "U0GRACE", text: "if a &lt; b &amp;&amp; c &gt; d" },
      { ts: "100.1", user: "U0ADA", text: "first <@U0GRACE>", files: [{ name: "a.png" }] },
      { ts: "100.2", bot_id: "B1", bot_profile: { name: "CI" }, text: "build failed" },
      { ts: "100.4", user: "U0ADA", text: "" },
      { ts: "100.5", user: "U0ADA", text: "the mention itself" },
      { ts: "100.6", user: "U0ADA", text: "after" },
    ],
    "100.5",
    async (userId) => (userId === "U0ADA" ? "Ada" : "Grace"),
  );
  assert.deepStrictEqual(earlier, [
    { userId: "U0ADA", name: "Ada", isBot: false, text: "first <@U0GRACE>", fileNames: ["a.png"] },
    { userId: "", name: "CI", isBot: true, text: "build failed", fileNames: [] },
    {
      userId: "U0GRACE",
      name: "Grace",
      isBot: false,
      text: "if a < b && c > d",
      fileNames: [],
    },
  ]);
});
