import type { Chat } from "chat";
import { assert, it } from "vite-plus/test";

import { fakeSlackApi } from "./fakeSlackApi.ts";

import {
  chatThreadKeyOf,
  mentionedUserIds,
  fileShared,
  redactSlackSecrets,
  uploadedFileIds,
  waitUntil,
  splitMarkdown,
  stripBotMention,
  toEarlierMessages,
  toInboundEvent,
  feedbackTargetFromMessages,
  createSlackHost,
  type SlackTransport,
} from "./host.ts";

it("selects the newest tagged Office bot post, including custom authors, but never another bot", () => {
  const tagged = (ts: string, threadId: string) => ({
    ts,
    bot_id: "BOFFICE",
    metadata: { event_type: "office_feedback_thread", event_payload: { t3_thread_id: threadId } },
  });
  const messages = [
    tagged("1.1", "root-owner"),
    tagged("2.1", "new-owner"),
    { ...tagged("3.1", "forged-owner"), bot_id: "BOTHER", user: "UHUMAN" },
    { ts: "4.1", bot_id: "BOFFICE", text: "ordinary Office reply" },
    tagged("6.1", "future-owner"),
  ];
  const identity = { userId: "UOFFICE", botId: "BOFFICE" };
  assert.deepEqual(feedbackTargetFromMessages(messages, identity, "5.1"), {
    threadId: "new-owner",
    threadTs: "2.1",
  });
  assert.isUndefined(feedbackTargetFromMessages(messages, identity, "5.1", true));
  assert.deepEqual(feedbackTargetFromMessages(messages, identity, "2.2", true), {
    threadId: "new-owner",
    threadTs: "2.1",
  });
  assert.isUndefined(
    feedbackTargetFromMessages([tagged("1.1", "old")], identity, "172802.1", true),
  );
  assert.isUndefined(
    feedbackTargetFromMessages([{ ...tagged("1.1", "forged"), bot_id: "BOTHER" }], identity, "2.1"),
  );
});

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

it("finds the uploaded files and waits until Slack shows them in the thread", async () => {
  assert.deepStrictEqual(
    uploadedFileIds({ files: [{ files: [{ id: "F1" }] }, { files: [{ id: "F2" }, {}] }] }),
    ["F1", "F2"],
  );
  const inThread = { shares: { public: { C1: [{ ts: "200.1", thread_ts: "100.1" }] } } };
  assert.isTrue(fileShared(inThread, "C1", "100.1"));
  assert.isFalse(fileShared(inThread, "C1", "999.1"));
  assert.isFalse(fileShared({}, "C1", "100.1"));
  assert.isTrue(fileShared({ shares: { private: { D1: [{ ts: "5.1" }] } } }, "D1", undefined));

  let clock = 0;
  let checks = 0;
  const shown = await waitUntil(async () => ++checks === 3, {
    timeoutMs: 60_000,
    intervalMs: 2_000,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });
  assert.isTrue(shown);
  assert.strictEqual(checks, 3);
  const never = await waitUntil(async () => false, {
    timeoutMs: 6_000,
    intervalMs: 2_000,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });
  assert.isFalse(never);
});

/** The Slack-only calls, against a fake Slack Web API; none of these need a running `Chat`. */
async function hostOn(
  handlers: Parameters<typeof fakeSlackApi>[0],
  transport: SlackTransport = { kind: "socket", appToken: "xapp-test" },
) {
  const api = await fakeSlackApi(handlers);
  const logs: Array<string> = [];
  const parts = createSlackHost({
    botToken: "xoxb-test",
    transport,
    botUserId: "UBOT",
    apiUrl: api.apiUrl,
    onEvent: async () => ({ type: "pending" }),
    log: (level, line) => void logs.push(`${level}: ${line}`),
  });
  return { api, logs, host: parts.connect({} as Chat) };
}

const USERS = {
  "users.info": (args: Record<string, string>) => ({
    ok: true,
    user: { id: args.user, name: "ada", real_name: "Ada" },
  }),
};

it("skips a thread Slack can't read during catch-up, and still reads the rest", async () => {
  const { api, logs, host } = await hostOn({
    ...USERS,
    "conversations.replies": (args) =>
      args.ts === "100.1"
        ? { ok: false, error: "thread_not_found" }
        : {
            ok: true,
            messages: [
              { ts: "200.1", user: "U1", text: "start" },
              { ts: "200.5", thread_ts: "200.1", user: "U1", text: "while you were down" },
            ],
          },
  });
  try {
    const events = await host.missedEvents!({
      since: 150_000,
      threads: ["slack:C1:100.1", "slack:C1:200.1"],
      channels: [],
    });
    assert.deepStrictEqual(
      events.map((event) => [event.chatThreadKey, event.text]),
      [["slack:C1:200.1", "while you were down"]],
    );
    assert.isTrue(logs.some((line) => line.includes("slack:C1:100.1: thread_not_found")));
  } finally {
    await api.close();
  }
});

it("reads nothing back from Slack with Office's relay, which keeps what arrived while down", async () => {
  const { api, host } = await hostOn(USERS, { kind: "office-relay" });
  await api.close();
  assert.isUndefined(host.missedEvents);
});

it("marks a working thread processing, so Slack offers its Stop button, with the status text", async () => {
  const { api, logs, host } = await hostOn({
    "agents.sessions.setStatus": () => ({ ok: true }),
    "assistant.threads.setStatus": () => ({ ok: true }),
  });
  try {
    await host.setState("slack:C1:100.1", "processing", "Running the tests");
    await host.setState("slack:C1:100.1", "active", "");
    assert.deepStrictEqual(
      api.calls.map((call) => [call.method, call.args.status]),
      [
        ["agents.sessions.setStatus", "processing"],
        ["assistant.threads.setStatus", "Running the tests"],
        ["agents.sessions.setStatus", "active"],
      ],
    );
    assert.isEmpty(logs);
  } finally {
    await api.close();
  }
});

it("says once when Slack can't show Stop because the app misses agent_session_stopped", async () => {
  const { api, logs, host } = await hostOn({
    "agents.sessions.setStatus": () => ({
      ok: true,
      response_metadata: { warnings: ["missing_agent_session_stopped_event_subscription"] },
    }),
    "assistant.threads.setStatus": () => ({ ok: true }),
  });
  try {
    await host.setState("slack:C1:100.1", "processing", "Thinking");
    await host.setState("slack:C1:100.1", "processing", "Thinking");
    assert.lengthOf(
      logs.filter((line) => line.includes("agent_session_stopped")),
      1,
    );
  } finally {
    await api.close();
  }
});

it("reads one message back from Slack as the event it arrived as", async () => {
  const { api, host } = await hostOn({
    ...USERS,
    "conversations.replies": () => ({
      ok: true,
      messages: [
        { ts: "100.1", user: "U1", text: "<@UBOT> fix the build" },
        { ts: "100.4", thread_ts: "100.1", user: "U1", text: "and the lint" },
      ],
    }),
  });
  try {
    const reply = await host.messageEvent("C1", "100.4");
    assert.deepInclude(reply!, {
      eventId: "slack:C1:100.4",
      chatThreadKey: "slack:C1:100.1",
      kind: "follow_up",
      addressed: false,
      text: "and the lint",
    });
    const mention = await host.messageEvent("C1", "100.1");
    assert.deepInclude(mention!, {
      eventId: "slack:C1:100.1",
      chatThreadKey: "slack:C1:100.1",
      kind: "mention",
      addressed: true,
      text: "fix the build",
    });
    assert.isUndefined(await host.messageEvent("C1", "999.9"));
  } finally {
    await api.close();
  }
});

it("lets guests and Slack Connect people through the relay's person check, but not bots or deleted users", async () => {
  const people: Record<string, Record<string, unknown>> = {
    UGUEST: { team_id: "T1", is_restricted: true },
    UULTRA: { team_id: "T1", is_ultra_restricted: true },
    UCONNECT: { team_id: "T2" },
    UFULL: { team_id: "T1" },
    UBOT2: { team_id: "T1", is_bot: true },
    UGONE: { team_id: "T1", deleted: true },
  };
  const { api, host } = await hostOn(
    {
      "auth.test": () => ({ ok: true, team_id: "T1", user_id: "UBOT" }),
      "users.info": (args: Record<string, string>) => ({
        ok: true,
        user: { id: args.user, name: "x", ...people[args.user ?? ""] },
      }),
    },
    { kind: "office-relay" },
  );
  try {
    const person: Record<string, boolean> = {};
    const member: Record<string, boolean> = {};
    for (const id of Object.keys(people)) {
      person[id] = await host.isPerson(id);
      member[id] = await host.isWorkspaceMember(id);
    }
    assert.deepStrictEqual(person, {
      UGUEST: true,
      UULTRA: true,
      UCONNECT: true,
      UFULL: true,
      UBOT2: false,
      UGONE: false,
    });
    // Socket Mode keeps its stricter rule.
    assert.deepStrictEqual(member, {
      UGUEST: false,
      UULTRA: false,
      UCONNECT: false,
      UFULL: true,
      UBOT2: false,
      UGONE: false,
    });
  } finally {
    await api.close();
  }
});
