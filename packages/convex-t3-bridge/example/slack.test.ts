/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import componentTest from "../src/test.js";
import type { T3BridgeEvent } from "../src/validators.js";
import { api, internal } from "./convex/_generated/api.js";
import schema from "./convex/schema.js";
import crons from "./convex/crons.js";
import { slackText } from "./convex/slackApi.js";
import { runSlackHarness } from "./slack-harness.js";

const channel = "C0AJ5HR70PR";
const modules = import.meta.glob("./convex/**/*.ts");
const calls: { method: string; args: Record<string, unknown> }[] = [];
let history: unknown[];
let replies: unknown[];
let respond: (method: string) => Response;
const requestArgs = z.record(z.string(), z.unknown());
const createTest = () => {
  const t = convexTest(schema, modules);
  componentTest.register(t);
  return t;
};
type Test = ReturnType<typeof createTest>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.stubEnv("SLACK_BOT_TOKEN", "fake-slack-token");
  vi.stubEnv("SLACK_TEST_CHANNEL_ID", channel);
  vi.stubEnv("SLACK_TRIGGER_PREFIX", "t3bridge:");
  vi.stubEnv("SLACK_ALLOWED_USER_IDS", "UBOT, UDEV");
  vi.stubEnv("T3_MCP_TOKEN", "fake-t3-token");
  vi.stubEnv("T3_BRIDGE_REPLY_SECRET", "fake-secret");
  vi.stubEnv("T3_TEST_PROJECT_ID", "project");
  history = [];
  replies = [];
  calls.length = 0;
  respond = (method) =>
    Response.json({
      ok: true,
      ...(method === "conversations.history"
        ? { messages: history }
        : method === "conversations.replies"
          ? { messages: replies }
          : { ts: "1005.000001" }),
    });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      const method = new URL(String(url)).pathname.split("/").at(-1) ?? "";
      expect(String(url)).toBe(`https://slack.com/api/${method}`);
      const args = requestArgs.parse(JSON.parse(String(init?.body)));
      calls.push({ method, args });
      return respond(method);
    }),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function poll(t: Test) {
  await t.action(internal.slack.poll, {});
}
async function messages(t: Test) {
  return t.run((ctx) => ctx.db.query("slackMessages").collect());
}
async function threads(t: Test) {
  return t.run((ctx) => ctx.db.query("slackThreads").collect());
}
async function queued(t: Test) {
  return t.run((ctx) => ctx.db.query("slackOutput").collect());
}
async function seedThread(t: Test) {
  return t.run((ctx) =>
    ctx.db.insert("slackThreads", {
      channel,
      threadTs: "1001.000001",
      conversationKey: `slack:${channel}:1001.000001`,
      lastTs: "1001.000001",
      nextStatusAt: 0,
      outputLeaseUntil: 0,
    }),
  );
}
async function event(t: Test, payload: T3BridgeEvent) {
  await t.mutation(internal.t3.onEvent, { event: payload });
}

describe("Slack polling", () => {
  it("starts at now without a Slack call and never replays earlier messages", async () => {
    const t = createTest();
    history = [{ ts: "999.999999", text: "t3bridge: old", user: "UBOT" }];
    await poll(t);
    expect(calls).toEqual([]);
    vi.setSystemTime(1_003_000);
    await poll(t);
    expect(calls[0]).toMatchObject({
      method: "conversations.history",
      args: { oldest: "1000.000000" },
    });
    expect(await messages(t)).toEqual([]);
    expect(await threads(t)).toEqual([]);
  });

  it("accepts allowlisted triggers, ignores other users, filters prefixes and replies, dedupes repeated pages, and maps thread follow-ups", async () => {
    const t = createTest();
    await poll(t);
    vi.setSystemTime(1_003_000);
    history = [
      { ts: "1001.000001", text: "t3bridge: first", user: "UBOT", bot_id: "bot" },
      { ts: "1001.000001", text: "t3bridge: first", user: "UBOT", bot_id: "bot" },
      { ts: "1001.000002", text: "not a trigger" },
      { ts: "1001.000003", text: "prefix t3bridge: not a trigger" },
      {
        ts: "1001.000004",
        thread_ts: "1001.000001",
        text: "t3bridge: reply in history",
        user: "UBOT",
      },
      { ts: "1001.000005", text: "t3bridge:   ", user: "UBOT" },
      { ts: "1001.000006", text: "t3bridge: run something", user: "USTRANGER" },
    ];
    replies = [
      { ts: "1001.000001", text: "t3bridge: first", user: "UBOT" },
      {
        ts: "1002.000001",
        thread_ts: "1001.000001",
        text: "t3bridge: follow-up",
        user: "UBOT",
        bot_id: "bot",
      },
      { ts: "1002.000002", thread_ts: "1001.000001", text: "ordinary reply" },
      { ts: "1002.000003", thread_ts: "another-thread", text: "t3bridge: wrong thread" },
    ];
    await poll(t);
    vi.setSystemTime(1_006_000);
    await poll(t);
    const accepted = await messages(t);
    expect(accepted.map((message) => message.ts)).toEqual(["1001.000001", "1002.000001"]);
    expect(new Set(accepted.map((message) => message.conversationKey))).toEqual(
      new Set([`slack:${channel}:1001.000001`]),
    );
    expect(await threads(t)).toHaveLength(1);
    expect(calls.filter((call) => call.method === "conversations.replies")).toHaveLength(2);
    expect(
      await t.query(api.t3.getConversation, {
        conversationKey: `slack:${channel}:1001.000001`,
      }),
    ).toMatchObject({ conversationKey: `slack:${channel}:1001.000001` });
  });

  it("paginates before advancing a cursor and retries a 429 after Retry-After", async () => {
    const t = createTest();
    await poll(t);
    vi.setSystemTime(1_003_000);
    let page = 0;
    respond = () => {
      page++;
      if (page === 1)
        return Response.json({
          ok: true,
          messages: [{ ts: "1002.000001", text: "ignore" }],
          has_more: true,
          response_metadata: { next_cursor: "page-2" },
        });
      return new Response(null, { status: 429, headers: { "retry-after": "10" } });
    };
    await poll(t);
    expect(calls[1]?.args.cursor).toBe("page-2");
    expect(await t.run((ctx) => ctx.db.query("slackPollers").unique())).toMatchObject({
      lastTs: "1000.000000",
    });
    await poll(t);
    expect(calls).toHaveLength(2);
    vi.setSystemTime(1_013_000);
    respond = () => Response.json({ ok: true, messages: [] });
    await poll(t);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.args.oldest).toBe("1000.000000");
  });

  it("fences overlapping polls and stale ingestion", async () => {
    const t = createTest();
    await poll(t);
    const lease = await t.mutation(internal.slack.acquirePoll, { channel });
    expect(lease).not.toBeNull();
    expect(await t.mutation(internal.slack.acquirePoll, { channel })).toBeNull();
    expect(
      await t.mutation(internal.slack.ingest, {
        channel,
        lease: 1,
        throughTs: "1003.000000",
        messages: [{ ts: "1001.000001", text: "t3bridge: stale", user: "UBOT" }],
      }),
    ).toBe(false);
    expect(await messages(t)).toEqual([]);
  });

  it("no-ops without the token, with no Slack calls, state changes, or warning spam", async () => {
    const t = createTest();
    const threadId = await seedThread(t);
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    const warn = vi.spyOn(console, "warn");
    for (let count = 0; count < 4; count++) {
      await poll(t);
      await t.action(internal.slack.drain, { threadId });
    }
    expect(calls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.query("slackPollers").collect())).toEqual([]);
    warn.mockRestore();
  });
});

describe("Slack event output", () => {
  it("reacts to the trigger, uses one throttled status, posts the final answer, and marks status Done", async () => {
    const t = createTest();
    const threadId = await seedThread(t);
    const thread = (await threads(t))[0];
    if (!thread) throw new Error("Missing thread");
    const base = { conversationKey: thread.conversationKey, threadId: "t3-thread", runId: "run" };
    await t.run((ctx) =>
      ctx.db.insert("slackMessages", {
        channel,
        ts: "1001.000001",
        conversationKey: thread.conversationKey,
        started: false,
      }),
    );
    await event(t, { ...base, type: "turnStarted", origin: "send" });
    const item = {
      position: 1,
      itemId: "item",
      runId: "run",
      createdBy: null,
      creationSource: null,
      type: "tool",
      status: "running",
      title: "Read code",
      text: null,
      updatedAt: "now",
    };
    const activity = {
      conversationKey: base.conversationKey,
      threadId: base.threadId,
      type: "activity",
      item,
    } satisfies T3BridgeEvent;
    await event(t, activity);
    await event(t, activity);
    expect((await queued(t)).map((job) => job.kind)).toEqual(["reaction", "status"]);
    await t.action(internal.slack.drain, { threadId });
    await t.action(internal.slack.drain, { threadId });
    vi.setSystemTime(1_003_000);
    await event(t, { ...activity, item: { ...item, title: "Run tests" } });
    await t.action(internal.slack.drain, { threadId });
    await event(t, { ...base, type: "turnEnded", status: "completed", finalText: "answer" });
    await t.action(internal.slack.drain, { threadId });
    // Done waits for the same three-second chat.update throttle.
    await t.action(internal.slack.drain, { threadId });
    vi.setSystemTime(1_006_000);
    await t.action(internal.slack.drain, { threadId });
    expect(calls.map((call) => call.method)).toEqual([
      "reactions.add",
      "chat.postMessage",
      "chat.update",
      "chat.postMessage",
      "chat.update",
    ]);
    expect(calls[0]?.args).toMatchObject({ name: "eyes", timestamp: "1001.000001" });
    expect(calls[2]?.args).toMatchObject({ ts: "1005.000001", text: "Working: Run tests" });
    expect(calls[3]?.args).toMatchObject({ thread_ts: thread.threadTs, text: "answer" });
    expect(calls[4]?.args.text).toBe("Done");
    expect((await threads(t))[0]?.statusTs).toBe("1005.000001");
    expect(await queued(t)).toEqual([]);
    vi.setSystemTime(1_009_000);
    await t.run((ctx) =>
      ctx.db.insert("slackMessages", {
        channel,
        ts: "1008.000001",
        conversationKey: thread.conversationKey,
        started: false,
      }),
    );
    await event(t, { ...base, runId: "follow-up", type: "turnStarted", origin: "send" });
    await event(t, { ...activity, item: { ...item, runId: "follow-up" } });
    await t.action(internal.slack.drain, { threadId });
    await t.action(internal.slack.drain, { threadId });
    expect(calls.at(-1)).toMatchObject({
      method: "chat.update",
      args: { ts: "1005.000001", text: "Working: Read code" },
    });
    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2);
  });

  it("posts only explicit replies for background turns and removes routing headers and keys", async () => {
    const t = createTest();
    const threadId = await seedThread(t);
    const conversationKey = `slack:${channel}:1001.000001`;
    const base = { conversationKey, threadId: "t3-thread", runId: "wake" };
    await event(t, { ...base, type: "turnStarted", origin: "background" });
    await event(t, {
      ...base,
      type: "turnEnded",
      status: "completed",
      finalText: "must stay private",
    });
    expect(await queued(t)).toEqual([]);
    const key = `${conversationKey}.${"a".repeat(64)}`;
    await event(t, {
      ...base,
      type: "reply",
      replyId: "reply-1",
      final: true,
      files: [],
      text: `<!-- t3_reply_key: ${key} -->\nhello ${key}`,
    });
    await t.action(internal.slack.drain, { threadId });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.text).toBe("hello [redacted]");
    expect(slackText(`<!-- t3_reply_key: ${key} -->`, conversationKey)).toBe("");
  });

  it("retries output 429s, serializes output, and swallows other Slack errors", async () => {
    const t = createTest();
    const threadId = await seedThread(t);
    await t.run((ctx) =>
      ctx.db.insert("slackOutput", {
        threadId,
        kind: "reply",
        text: "hello",
        retryAt: 0,
      }),
    );
    respond = () => new Response(null, { status: 429, headers: { "retry-after": "4" } });
    await t.action(internal.slack.drain, { threadId });
    await t.action(internal.slack.drain, { threadId });
    expect(calls).toHaveLength(1);
    expect(await queued(t)).toHaveLength(1);
    vi.setSystemTime(1_004_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    respond = () => Response.json({ ok: false, error: "missing_scope" });
    await t.action(internal.slack.drain, { threadId });
    expect(warn).toHaveBeenCalledWith("Slack output failed:", "missing_scope");
    expect(await queued(t)).toEqual([]);
    warn.mockRestore();
  });

  it("registers a three-second host cron", () => {
    if (!("export" in crons) || typeof crons.export !== "function")
      throw new Error("Cron metadata unavailable");
    expect(JSON.parse(z.string().parse(crons.export()))).toMatchObject({
      "poll Slack test channel": { schedule: { type: "interval", seconds: 3 } },
    });
  });
});

describe("Slack harness safety", () => {
  it("refuses a different configured channel or channel override without a request", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    try {
      vi.stubEnv("SLACK_TEST_CHANNEL_ID", "another-channel");
      await runSlackHarness("another-channel");
      vi.stubEnv("SLACK_TEST_CHANNEL_ID", channel);
      await runSlackHarness("another-channel");
      expect(calls).toEqual([]);
      expect(log.mock.calls.map((args) => args[0])).toHaveLength(6);
      expect(log.mock.calls.every((args) => String(args[0]).startsWith("FAIL "))).toBe(true);
    } finally {
      log.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it("posts only one root and one follow-up, checks eyes, and does not print either token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    const answerTokens: string[] = [];
    let postCount = 0;
    try {
      respond = (method) => {
        if (method === "chat.postMessage") {
          postCount++;
          const text = z.string().parse(calls.at(-1)?.args.text);
          const expected = text.split("Reply with exactly: ")[1];
          if (!expected) throw new Error("Missing expected answer");
          answerTokens.push(expected);
          return Response.json({ ok: true, ts: postCount === 1 ? "1001.000001" : "1003.000001" });
        }
        return Response.json({
          ok: true,
          messages: [
            { ts: "1001.000001", text: "trigger", reactions: [{ name: "eyes", count: 1 }] },
            ...answerTokens.map((text, index) => ({
              ts: index === 0 ? "1002.000001" : "1004.000001",
              thread_ts: "1001.000001",
              text,
              bot_id: "dev-affil",
            })),
          ],
        });
      };
      await runSlackHarness(channel);
      const posts = calls.filter((call) => call.method === "chat.postMessage");
      expect(posts).toHaveLength(2);
      expect(posts[0]?.args.thread_ts).toBeUndefined();
      expect(posts[1]?.args.thread_ts).toBe("1001.000001");
      expect(posts.every((post) => post.args.channel === channel)).toBe(true);
      expect(log.mock.calls.map((args) => args[0])).toEqual([
        "PASS threaded answer",
        "PASS eyes reaction",
        "PASS thread follow-up",
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("fake-slack-token");
      for (const token of answerTokens) expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    } finally {
      log.mockRestore();
      process.exitCode = previousExitCode;
    }
  });
});
