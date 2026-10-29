import { assert, it } from "vite-plus/test";

import {
  mentionedUserIds,
  redactSlackSecrets,
  stripBotMention,
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
