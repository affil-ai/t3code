// @effect-diagnostics globalDate:off globalFetch:off nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
import * as NodeCrypto from "node:crypto";

import { createLinearAdapter } from "@chat-adapter/linear";
import { Message, parseMarkdown, type Thread } from "chat";
import { assert, it, vi } from "vite-plus/test";

import type { InboundEvent } from "../bridge.ts";
import { parseConfig } from "../config.ts";
import { startWebhookServer } from "../webhookServer.ts";
import {
  type LinearApi,
  linearEvent,
  sessionIdOf,
  linearPlatform,
  mimeTypeOf,
  uploadToLinear,
} from "./platform.ts";
import { downloadUpload, takeUploads, uploadEventFiles } from "./files.ts";
import { authRetry, isAuthError, retryMethods, startInBackground } from "./startup.ts";

const THREAD = "linear:issue-1:s:session-1";

/** A client whose session has no other prompts and takes every activity. */
const noSession = {
  createAgentActivity: async () => ({}),
  agentSession: async () => ({ activities: async () => ({ nodes: [] }) }),
};

const message = (id: string, context?: string) =>
  new Message({
    id,
    threadId: THREAD,
    text: "@office fix the flaky test",
    formatted: parseMarkdown("@office fix the flaky test"),
    raw: {
      kind: "agent_session_comment",
      agentSessionId: "session-1",
      agentSessionPromptContext: context,
    },
    author: { userId: "user-1", userName: "ada", fullName: "Ada", isBot: false, isMe: false },
    metadata: { dateSent: new Date(0), edited: false },
    attachments: [],
  });

it("makes a session's first message an event with Linear's context, routed by team", () => {
  const first = linearEvent(
    THREAD,
    message("c-1", "<issue>ENG-7: flaky test</issue>"),
    "mention",
    "ENG",
    new Set(["ENG"]),
  );
  assert.strictEqual(first.eventId, "linear:c-1");
  assert.strictEqual(first.channelId, "ENG");
  assert.isFalse(first.direct);
  assert.include(
    first.text,
    "Linear's context for this session:\n<issue>ENG-7: flaky test</issue>",
  );
  // Follow-ups don't repeat the context; a team without a route takes the default one.
  const later = linearEvent(
    THREAD,
    message("c-2", "<issue/>"),
    "follow_up",
    "OPS",
    new Set(["ENG"]),
  );
  assert.strictEqual(later.text, "@office fix the flaky test");
  assert.isTrue(later.direct);
});

it("uploads a file to Linear and links it, inline for images", async () => {
  const puts: Array<{ url: string; type: string | null }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    puts.push({ url, type: new Headers(init.headers).get("content-type") });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    const api: LinearApi = {
      ...noSession,
      issue: async () => ({ team: Promise.resolve({ key: "ENG" }) }),
      fileUpload: async (_type, filename) => ({
        uploadFile: {
          uploadUrl: `https://upload/${filename}`,
          assetUrl: `https://asset/${filename}`,
          headers: [],
        },
      }),
    };
    assert.strictEqual(
      await uploadToLinear(api, { data: Buffer.from("png"), filename: "chart.png" }),
      "![chart.png](https://asset/chart.png)",
    );
    assert.strictEqual(
      await uploadToLinear(api, { data: Buffer.from("pdf"), filename: "report.pdf" }),
      "[report.pdf](https://asset/report.pdf)",
    );
    assert.deepStrictEqual(puts, [
      { url: "https://upload/chart.png", type: "image/png" },
      { url: "https://upload/report.pdf", type: "application/pdf" },
    ]);
    assert.strictEqual(mimeTypeOf("x.unknown"), "application/octet-stream");
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("sends a thought before handing a session to the core, and reads each issue's team once", async () => {
  const order: Array<string> = [];
  const events: Array<InboundEvent> = [];
  let issueReads = 0;
  const { deliver, platform } = linearPlatform({
    chat: () => undefined,
    adapter: () => ({
      startTyping: async (_thread: string, status?: string) => void order.push(`thought ${status}`),
      addReaction: async () => {},
      linearClient: {
        ...noSession,
        issue: async () => {
          issueReads += 1;
          return { team: Promise.resolve({ key: "eng" }) };
        },
        fileUpload: async () => ({}),
      },
    }),
    access: { allowedUserIds: [], allowEveryone: true },
    teams: [{ team: "ENG", projectId: "p-eng", worktreeFrom: "dev" }],
    defaultRoute: { projectId: "p-default" },
    onEvent: async (event) => {
      order.push("event");
      events.push(event);
      return { type: "pending" };
    },
    log: () => {},
  });
  const thread = { id: THREAD } as Thread;
  await deliver(thread, message("c-1"), undefined, "mention");
  await deliver(thread, message("c-2"), undefined, "subscribed");
  assert.deepStrictEqual(order, [
    "thought Reading the issue",
    "event",
    "thought Reading the issue",
    "event",
  ]);
  assert.strictEqual(issueReads, 1);
  assert.deepStrictEqual(
    events.map((event) => [event.kind, event.channelId, event.direct]),
    [
      ["mention", "ENG", false],
      ["follow_up", "ENG", false],
    ],
  );
  assert.deepStrictEqual(platform.channelRoutes, [
    { channelId: "ENG", projectId: "p-eng", worktreeFrom: "dev" },
  ]);
});

it("serves only the webhook path, and the adapter refuses requests Linear didn't sign", async () => {
  const secret = "test-secret";
  const adapter = createLinearAdapter({
    apiKey: "lin_api_test",
    webhookSecret: secret,
    mode: "agent-sessions",
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    },
  });
  const server = await startWebhookServer(
    0,
    [{ path: "/linear/webhook", handle: (request) => adapter.handleWebhook(request) }],
    () => {},
  );
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  // Linear refuses stale timestamps; a fixed clock keeps the signed request fresh.
  const NOW = 1_800_000_000_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  try {
    assert.strictEqual((await fetch(url("/"), { method: "POST" })).status, 404);
    assert.strictEqual((await fetch(url("/linear/webhook/x"), { method: "POST" })).status, 404);
    assert.strictEqual((await fetch(url("/linear/webhook"))).status, 405);
    const body = JSON.stringify({
      type: "Reaction",
      action: "create",
      organizationId: "org-1",
      webhookTimestamp: NOW,
      data: { id: "r-1", emoji: "eyes", commentId: "c-1" },
    });
    const unsigned = await fetch(url("/linear/webhook"), { method: "POST", body });
    assert.isAtLeast(unsigned.status, 400);
    const forged = await fetch(url("/linear/webhook"), {
      method: "POST",
      body,
      headers: { "linear-signature": "0".repeat(64), "content-type": "application/json" },
    });
    assert.isAtLeast(forged.status, 400);
    const signature = NodeCrypto.createHmac("sha256", secret).update(body).digest("hex");
    const signed = await fetch(url("/linear/webhook"), {
      method: "POST",
      body,
      headers: { "linear-signature": signature, "content-type": "application/json" },
    });
    assert.strictEqual(signed.status, 200);
  } finally {
    vi.useRealTimers();
    server.close();
  }
});

it("reads the linear block: the default route, team routes, and everyone allowed unless set", () => {
  const base = { t3Url: "http://127.0.0.1:1", channelProjects: [], allowedUserIds: [] };
  assert.isUndefined(parseConfig(base).linear);
  assert.deepStrictEqual(
    parseConfig({
      ...base,
      linear: { projectId: "p", teams: [{ team: "ENG", projectId: "p-eng", worktreeFrom: "dev" }] },
    }).linear,
    {
      botName: "office",
      webhookPort: 3930,
      webhookPath: "/linear/webhook",
      defaultRoute: { projectId: "p" },
      teams: [{ team: "ENG", projectId: "p-eng", worktreeFrom: "dev" }],
      allowedUserIds: [],
      allowEveryone: true,
    },
  );
  assert.throws(() => parseConfig({ ...base, linear: { teams: [] } }), /projectId/);
});

it("starts Linear in the background, retrying until it has a token and its own user", async () => {
  const delays: Array<number> = [];
  const retries: Array<() => void> = [];
  const logs: Array<string> = [];
  let calls = 0;
  const adapter = {
    botUserId: undefined as string | undefined,
    initialize: async (_chat: unknown) => {
      calls += 1;
      if (calls === 1) throw new Error("token fetch failed");
      // The adapter only warns when it can't look itself up; that is a failure too.
      if (calls === 3) adapter.botUserId = "app-user";
    },
  };
  const started = startInBackground(adapter, {
    log: (line) => void logs.push(line),
    schedule: (ms, run) => {
      delays.push(ms);
      retries.push(run);
    },
  });
  // Chat's start returns at once, so Slack and iMessage don't wait on Linear.
  await adapter.initialize({} as never);
  await started.latest();
  assert.isFalse(started.ready());
  retries.shift()!();
  await started.latest();
  assert.isFalse(started.ready());
  retries.shift()!();
  await started.latest();
  assert.isTrue(started.ready());
  assert.deepStrictEqual(delays, [15_000, 30_000]);
  assert.include(logs[0], "token fetch failed");
  assert.include(logs[1], "didn't say which user");
  assert.strictEqual(logs[2], "Linear: connected after 3 tries.");
});

it("takes Linear uploads out of a prompt as files, leaving a note where each link was", () => {
  const body =
    "look ![shot.png](https://uploads.linear.app/a/b/shot.png?sig=1) and [report.pdf](https://uploads.linear.app/c/report.pdf)\nraw https://uploads.linear.app/d/IMG_1.HEIC and https://example.com/x.png";
  const { text, uploads } = takeUploads(body);
  assert.strictEqual(
    text,
    "look [image: shot.png] and [file: report.pdf]\nraw [file: IMG_1.HEIC] and https://example.com/x.png",
  );
  assert.notInclude(text, "uploads.linear.app");
  assert.deepStrictEqual(uploadEventFiles(uploads), [
    { name: "shot.png", url: "https://uploads.linear.app/a/b/shot.png?sig=1" },
    { name: "report.pdf", url: "https://uploads.linear.app/c/report.pdf" },
    // HEIC arrives as JPEG, as iMessage photos do.
    { name: "IMG_1.jpg", mimeType: "image/jpeg", url: "https://uploads.linear.app/d/IMG_1.HEIC" },
  ]);
  // The event carries the files, and the agent's text has no signed links.
  const event = linearEvent(
    THREAD,
    new Message({
      id: "c-9",
      threadId: THREAD,
      text: "look https://uploads.linear.app/a/b/shot.png?sig=1",
      formatted: parseMarkdown("look"),
      raw: { kind: "agent_session_comment", comment: { body } },
      author: { userId: "u", userName: "ada", fullName: "Ada", isBot: false, isMe: false },
      metadata: { dateSent: new Date(0), edited: false },
      attachments: [],
    }),
    "follow_up",
    "ENG",
    new Set(),
  );
  assert.strictEqual(event.files.length, 3);
  assert.notInclude(event.text, "uploads.linear.app");
});

it("downloads an upload with the bridge's token, only from Linear, and turns HEIC into JPEG", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, auth: new Headers(init.headers).get("authorization") });
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": url.endsWith(".HEIC") ? "image/heic" : "image/png" },
    });
  }) as typeof fetch;
  try {
    const options = {
      authorization: () => "Bearer app-token",
      convertHeic: async () => new Uint8Array([9]),
    };
    assert.deepStrictEqual(
      [...(await downloadUpload("https://uploads.linear.app/a/shot.png", options))],
      [1, 2, 3],
    );
    assert.deepStrictEqual(
      [...(await downloadUpload("https://uploads.linear.app/d/IMG_1.HEIC", options))],
      [9],
    );
    // The token never goes anywhere else.
    for (const url of ["https://example.com/x.png", "http://uploads.linear.app/x.png"]) {
      let refused = false;
      await downloadUpload(url, options).catch(() => (refused = true));
      assert.isTrue(refused, url);
    }
    assert.deepStrictEqual(
      seen.map((each) => each.auth),
      ["Bearer app-token", "Bearer app-token"],
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("posts only the answer as a response: a question asks, an update is a thought, a step an action", async () => {
  const activities: Array<Record<string, unknown>> = [];
  const responses: Array<string> = [];
  const { platform } = linearPlatform({
    chat: () =>
      ({
        thread: () => ({
          post: async (message: { markdown: string }) => void responses.push(message.markdown),
        }),
      }) as never,
    adapter: () => ({
      startTyping: async () => {},
      addReaction: async () => {},
      linearClient: {
        ...noSession,
        issue: async () => ({ team: Promise.resolve({ key: "ENG" }) }),
        fileUpload: async () => ({}),
        createAgentActivity: async (input) => void activities.push(input as never),
      },
    }),
    access: { allowedUserIds: [], allowEveryone: true },
    teams: [],
    defaultRoute: { projectId: "p" },
    onEvent: async () => ({ type: "pending" }),
    log: () => {},
  });
  assert.strictEqual(sessionIdOf(THREAD), "session-1");
  await platform.post({
    chatThreadKey: THREAD,
    text: "Which branch? 1. dev 2. main",
    kind: "question",
  });
  await platform.post({ chatThreadKey: THREAD, text: "Here is the chart.", kind: "update" });
  await platform.step!(THREAD, {
    itemId: "i",
    action: "Ran",
    parameter: "pnpm test",
    result: "Done",
  });
  await platform.post({ chatThreadKey: THREAD, text: "All done." });
  assert.deepStrictEqual(activities, [
    {
      agentSessionId: "session-1",
      content: { type: "elicitation", body: "Which branch? 1. dev 2. main" },
    },
    { agentSessionId: "session-1", content: { type: "thought", body: "Here is the chart." } },
    {
      agentSessionId: "session-1",
      content: { type: "action", action: "Ran", parameter: "pnpm test", result: "Done" },
    },
  ]);
  assert.deepStrictEqual(responses, ["All done."]);
});

it("hands over prompts the session has but the bridge never got, oldest first, before the new one", async () => {
  const events: Array<InboundEvent> = [];
  const logs: Array<string> = [];
  const prompt = (id: string, at: number, body: string) => ({
    id: `activity-${id}`,
    sourceCommentId: id,
    createdAt: new Date(at),
    userId: "user-1",
    user: Promise.resolve({ name: "Ada" }),
    content: { __typename: "AgentActivityPromptContent", body },
  });
  const { deliver } = linearPlatform({
    chat: () => undefined,
    adapter: () => ({
      startTyping: async () => {},
      addReaction: async () => {},
      linearClient: {
        ...noSession,
        issue: async () => ({ team: Promise.resolve({ key: "ENG" }) }),
        fileUpload: async () => ({}),
        agentSession: async () => ({
          activities: async () => ({
            nodes: [
              prompt("c-new", 3_000, "@office fix the flaky test"),
              // Handled before a restart: the core's store knows it.
              prompt("c-before-restart", 500, "old"),
              prompt("c-lost", 2_000, "what model are u?"),
              // The session's first prompt was handed over when it started.
              prompt("c-1", 1_000, "start"),
              {
                id: "a-response",
                createdAt: new Date(2_500),
                content: { __typename: "AgentActivityResponseContent", body: "ok" },
              },
            ],
          }),
        }),
      },
    }),
    access: { allowedUserIds: [], allowEveryone: true },
    teams: [],
    defaultRoute: { projectId: "p" },
    onEvent: async (event) => {
      events.push(event);
      return { type: "pending" };
    },
    log: (line) => void logs.push(line),
    isHandled: (eventId) => eventId === "linear:c-before-restart",
  });
  const thread = { id: THREAD } as Thread;
  await deliver(thread, message("c-1"), undefined, "mention");
  const latest = new Message({
    ...message("c-new"),
    metadata: { dateSent: new Date(3_000), edited: false },
  });
  await deliver(thread, latest, undefined, "subscribed");
  assert.deepStrictEqual(
    events.map((event) => [event.eventId, event.kind, event.text]),
    [
      ["linear:c-1", "mention", "@office fix the flaky test"],
      ["linear:c-lost", "follow_up", "what model are u?"],
      ["linear:c-new", "follow_up", "@office fix the flaky test"],
    ],
  );
  assert.strictEqual(events[1]!.author.fullName, "Ada");
  assert.lengthOf(
    logs.filter((line) => line.includes("hadn't reached the bridge")),
    1,
  );
});

it("gets a new Linear token once when Linear says the bridge isn't signed in, and retries", async () => {
  const logs: Array<string> = [];
  let refreshes = 0;
  let token = "old";
  const retry = authRetry(
    async () => {
      refreshes += 1;
      token = "new";
    },
    (line) => void logs.push(line),
  );
  const signedIn = async () => {
    if (token === "old")
      throw Object.assign(new Error("Authentication required, not authenticated"), {
        type: "AuthenticationError",
      });
    return token;
  };
  // Calls that fail together share one refresh.
  assert.deepStrictEqual(await Promise.all([retry(signedIn), retry(signedIn)]), ["new", "new"]);
  assert.strictEqual(refreshes, 1);
  // Other errors aren't retried, and a call still refused after a refresh fails.
  let other = 0;
  await retry(async () => {
    other += 1;
    throw new Error("rate limited");
  }).catch(() => {});
  assert.strictEqual(other, 1);
  token = "old";
  const stuck = { refresh: async () => {} };
  let stuckCalls = 0;
  await authRetry(stuck.refresh, () => {})(async () => {
    stuckCalls += 1;
    return signedIn();
  }).catch(() => {});
  assert.strictEqual(stuckCalls, 2);
  assert.isTrue(isAuthError({ status: 401 }));
  assert.isTrue(isAuthError(new Error("Linear answered 401 for an upload.")));
  assert.isFalse(isAuthError(new Error("Linear answered 404 for an upload.")));
  // Adapter methods Chat SDK calls get the same retry.
  token = "old";
  const adapter = {
    posts: 0,
    postMessage: async function (this: { posts: number }) {
      this.posts += 1;
      return signedIn();
    },
  };
  retryMethods(adapter, ["postMessage", "missing"], retry);
  assert.strictEqual(await adapter.postMessage(), "new");
  assert.strictEqual(adapter.posts, 2);
  assert.include(logs[0], "getting a new one");
});

it("logs each webhook's method, path, status and event type, and nothing from its body", async () => {
  const logs: Array<string> = [];
  const server = await startWebhookServer(
    0,
    [
      {
        path: "/linear/webhook",
        handle: async () => new Response("OK"),
        kind: (headers) => headers.get("linear-event") ?? undefined,
      },
    ],
    (line) => void logs.push(line),
  );
  try {
    const url = `http://127.0.0.1:${server.port}`;
    await fetch(`${url}/linear/webhook`, {
      method: "POST",
      body: JSON.stringify({ secret: "do-not-log" }),
      headers: { "linear-event": "AgentSessionEvent<script>" },
    });
    await fetch(`${url}/nope`);
    assert.deepStrictEqual(logs, [
      "Webhook POST /linear/webhook 200 (AgentSessionEventscript)",
      "Webhook GET /nope 404",
    ]);
  } finally {
    server.close();
  }
});
