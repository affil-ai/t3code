// @effect-diagnostics globalDate:off globalFetch:off nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
import * as NodeCrypto from "node:crypto";

import { createLinearAdapter } from "@chat-adapter/linear";
import { Message, parseMarkdown, type Thread } from "chat";
import { assert, it, vi } from "vite-plus/test";

import type { InboundEvent } from "../bridge.ts";
import { parseConfig } from "../config.ts";
import { reactOn } from "../platform.ts";
import { startWebhookServer } from "../webhookServer.ts";
import {
  commentEvent,
  type LinearApi,
  linearEvent,
  REACTIONS_UNSEEN,
  QUIET_DONE,
  sessionIdOf,
  linearPlatform,
  mimeTypeOf,
  uploadToLinear,
} from "./platform.ts";
import { downloadUpload, takeUploads, uploadEventFiles } from "./files.ts";
import { authRetry, isAuthError, retryMethods, startInBackground } from "./startup.ts";
import { commentOf, handlingLinearEvents, type LinearComment, type LinearStop } from "./stop.ts";

const THREAD = "linear:issue-1:s:session-1";

/** A client whose session has no other prompts and takes every activity. */
const noSession = {
  createAgentActivity: async () => ({}),
  updateAgentSession: async () => ({}),
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
  assert.isUndefined(later.title);
});

it("names a session's thread after its issue, not Linear's delegation notice", () => {
  const context =
    '<issue identifier="ENG-1878">\n<title>Build a settings page\n redesign</title>\n<description>…</description>\n</issue>';
  assert.strictEqual(
    linearEvent(THREAD, message("c-3", context), "mention", "ENG", new Set()).title,
    "ENG-1878 Build a settings page redesign",
  );
  assert.isUndefined(
    linearEvent(THREAD, message("c-4", "<issue>no title</issue>"), "mention", "ENG", new Set())
      .title,
  );
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
      botUserId: "bot",
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
    "look [image: shot.png] and [file: report.pdf]\nraw [image: IMG_1.jpg] and https://example.com/x.png",
  );
  assert.notInclude(text, "uploads.linear.app");
  assert.deepStrictEqual(uploadEventFiles(uploads), [
    {
      name: "shot.png",
      mimeType: "image/png",
      url: "https://uploads.linear.app/a/b/shot.png?sig=1",
    },
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
      botUserId: "bot",
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

it("ends a session still showing work when its run stays quiet, and leaves an ended one alone", async () => {
  const responses: Array<string> = [];
  const logs: Array<string> = [];
  let status = "active";
  const { platform } = linearPlatform({
    chat: () =>
      ({
        thread: () => ({
          post: async (message: { markdown: string }) => void responses.push(message.markdown),
        }),
      }) as never,
    adapter: () => ({
      startTyping: async () => {},
      botUserId: "bot",
      linearClient: {
        ...noSession,
        issue: async () => ({ team: Promise.resolve({ key: "ENG" }) }),
        fileUpload: async () => ({}),
        agentSession: async () => ({ status, activities: async () => ({ nodes: [] }) }),
      },
    }),
    access: { allowedUserIds: [], allowEveryone: true },
    teams: [],
    defaultRoute: { projectId: "p" },
    onEvent: async () => ({ type: "pending" }),
    log: (line) => void logs.push(line),
  });
  await platform.quiet!(THREAD);
  assert.deepStrictEqual(responses, [QUIET_DONE]);
  assert.include(logs.join("\n"), "session session-1 was active after a quiet run");
  // A second quiet wake after the answer, as a subagent's double wake gives, posts nothing.
  status = "complete";
  await platform.quiet!(THREAD);
  assert.deepStrictEqual(responses, [QUIET_DONE]);
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
      botUserId: "bot",
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
              // A session the bridge opened starts with a prompt Linear writes as the app.
              { ...prompt("a-opened", 100, "Work on ENG-9"), userId: "bot" },
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

it("turns Linear's <linear-image> tag into an image file named by its title, and drops the tag", () => {
  const src =
    "https://uploads.linear.app/org/00000000-0000-4000-8000-000000000001?signature=secret";
  const tag = (attrs: Record<string, unknown>) =>
    `<linear-image>${JSON.stringify({ type: "image", attrs })}</linear-image>`;
  const { text, uploads } = takeUploads(
    `${tag({ src, title: "image.png", width: 1246 })}\n\nwhat is this?\n${tag({ src: "https://uploads.linear.app/org/untitled" })}`,
  );
  assert.strictEqual(text, "[image: image.png]\n\nwhat is this?\n[image: untitled]");
  assert.notInclude(text, "signature");
  assert.deepStrictEqual(uploadEventFiles(uploads), [
    { name: "image.png", mimeType: "image/png", url: src },
    // No extension: still an image, named so T3 shows it to the model.
    { name: "untitled.png", mimeType: "image/png", url: "https://uploads.linear.app/org/untitled" },
  ]);
  // A tag that isn't JSON is left alone, and its link still never survives.
  const broken = takeUploads(
    "<linear-image>{not json https://uploads.linear.app/x/y}</linear-image>",
  );
  assert.notInclude(broken.text, "uploads.linear.app");
});

it("makes an issue one conversation: every session feeds it, and replies go to the latest session", async () => {
  const events: Array<InboundEvent> = [];
  const posts: Array<string> = [];
  const thoughts: Array<string> = [];
  const kept = new Map<string, string>();
  const { deliver, platform } = linearPlatform({
    chat: () =>
      ({
        thread: (id: string) => ({
          post: async (message: { markdown: string }) =>
            void posts.push(`${id} ${message.markdown}`),
          subscribe: async () => {},
        }),
      }) as never,
    adapter: () => ({
      startTyping: async (thread: string, status?: string) =>
        void thoughts.push(`${thread} ${status}`),
      botUserId: "bot",
      linearClient: {
        ...noSession,
        issue: async () => ({ team: Promise.resolve({ key: "ENG" }) }),
        fileUpload: async () => ({}),
      },
    }),
    access: { allowedUserIds: [], allowEveryone: true },
    teams: [],
    defaultRoute: { projectId: "p" },
    onEvent: async (event) => {
      events.push(event);
      return { type: "pending" };
    },
    log: () => {},
    // Kept across restarts.
    sessions: { get: (key) => kept.get(key), set: (key, id) => void kept.set(key, id) },
  });
  const first = "linear:issue-1:c:c-1:s:session-1";
  const second = "linear:issue-1:c:c-5:s:session-2";
  await deliver({ id: first } as Thread, message("c-1"), undefined, "mention");
  await platform.post({ chatThreadKey: "linear:issue-1", text: "first answer" });
  // A new @office mention on the same issue opens session 2: same conversation.
  await deliver({ id: second } as Thread, message("c-5"), undefined, "mention");
  await platform.setState!("linear:issue-1", "processing", "Running `pnpm test`");
  await platform.post({ chatThreadKey: "linear:issue-1", text: "second answer" });
  assert.deepStrictEqual(
    events.map((event) => event.chatThreadKey),
    ["linear:issue-1", "linear:issue-1"],
  );
  assert.deepStrictEqual(posts, [`${first} first answer`, `${second} second answer`]);
  assert.include(thoughts, `${second} Running \`pnpm test\``);
  assert.strictEqual(kept.get("linear:issue-1"), second);
  // A conversation bound to one session, from before issues shared a thread, still answers there.
  await platform.post({ chatThreadKey: first, text: "old binding" });
  assert.strictEqual(posts.at(-1), `${first} old binding`);
  assert.include(platform.firstTurnNote("key", events[0]!), "every agent session");
});

it("interrupts on a stop Linear signed, and never on one it didn't", async () => {
  const secret = "webhook-secret";
  const NOW = 1_800_000_000_000;
  const stops: Array<LinearStop> = [];
  const forwarded: Array<string> = [];
  const handle = handlingLinearEvents(
    async (request) => {
      forwarded.push(await request.text());
      return new Response("adapter");
    },
    { secret, now: () => NOW, log: () => {}, onStop: async (stop) => void stops.push(stop) },
  );
  const payload = (signal?: string, at = NOW) =>
    JSON.stringify({
      type: "AgentSessionEvent",
      action: "prompted",
      webhookTimestamp: at,
      agentSession: { id: "session-1", issueId: "issue-1" },
      agentActivity: {
        ...(signal ? { signal } : {}),
        user: { id: "user-1" },
        content: { body: "Stop" },
      },
    });
  const send = (body: string, signature: string) =>
    handle(
      new Request("http://127.0.0.1/linear/webhook", {
        method: "POST",
        body,
        headers: { "linear-signature": signature },
      }),
    );
  const sign = (body: string) => NodeCrypto.createHmac("sha256", secret).update(body).digest("hex");

  const signed = payload("stop");
  assert.strictEqual((await send(signed, sign(signed))).status, 200);
  assert.deepStrictEqual(stops, [{ issueId: "issue-1", sessionId: "session-1", userId: "user-1" }]);
  assert.deepStrictEqual(forwarded, []);

  // Forged, or signed but stale: no interrupt, and the adapter (which refuses it) gets it as sent.
  await send(signed, "0".repeat(64));
  const stale = payload("stop", NOW - 5 * 60_000);
  await send(stale, sign(stale));
  assert.lengthOf(stops, 1);
  assert.deepStrictEqual(forwarded, [signed, stale]);

  // An ordinary prompt goes to the adapter with its body intact.
  const prompt = payload();
  assert.strictEqual(await (await send(prompt, sign(prompt))).text(), "adapter");
  assert.strictEqual(forwarded.at(-1), prompt);
  assert.lengthOf(stops, 1);
});

it("asks a question with options as Linear's chooser, and as numbered text if Linear refuses it", async () => {
  const activities: Array<Record<string, unknown>> = [];
  let refuseSelect = false;
  const { platform } = linearPlatform({
    chat: () => undefined,
    adapter: () => ({
      startTyping: async () => {},
      botUserId: "bot",
      linearClient: {
        ...noSession,
        issue: async () => ({ team: Promise.resolve({ key: "ENG" }) }),
        fileUpload: async () => ({}),
        createAgentActivity: async (input) => {
          if (refuseSelect && input.signal === "select")
            throw new Error("Argument Validation Error");
          activities.push(input as never);
        },
      },
    }),
    access: { allowedUserIds: [], allowEveryone: true },
    teams: [],
    defaultRoute: { projectId: "p" },
    onEvent: async () => ({ type: "pending" }),
    log: () => {},
  });
  const question = {
    chatThreadKey: THREAD,
    text: "Deploy\nWhich environment?\n1. Staging\n2. Production\n\nReply with a number.",
    kind: "question" as const,
    choices: { question: "Deploy\nWhich environment?", options: ["Staging", "Production"] },
  };
  await platform.post(question);
  refuseSelect = true;
  await platform.post(question);
  assert.deepStrictEqual(activities, [
    {
      agentSessionId: "session-1",
      content: { type: "elicitation", body: "Deploy\nWhich environment?" },
      signal: "select",
      signalMetadata: {
        options: [
          { label: "Staging", value: "Staging" },
          { label: "Production", value: "Production" },
        ],
      },
    },
    { agentSessionId: "session-1", content: { type: "elicitation", body: question.text } },
  ]);
});

it("shows T3's to-do list as the session's plan, replaced whole and only when it changes", async () => {
  const plans: Array<unknown> = [];
  const { platform } = linearPlatform({
    chat: () => undefined,
    adapter: () => ({
      startTyping: async () => {},
      botUserId: "bot",
      linearClient: {
        ...noSession,
        issue: async () => ({ team: Promise.resolve({ key: "ENG" }) }),
        fileUpload: async () => ({}),
        updateAgentSession: async (id, input) => void plans.push([id, input.plan]),
      },
    }),
    access: { allowedUserIds: [], allowEveryone: true },
    teams: [],
    defaultRoute: { projectId: "p" },
    onEvent: async () => ({ type: "pending" }),
    log: () => {},
  });
  await platform.plan!(THREAD, [
    { text: "check date", status: "completed" },
    { text: "list files", status: "running" },
    { text: "read README", status: "pending" },
  ]);
  assert.deepStrictEqual(plans, [
    [
      "session-1",
      [
        { content: "check date", status: "completed" },
        { content: "list files", status: "inProgress" },
        { content: "read README", status: "pending" },
      ],
    ],
  ]);
});

it("holds files sent mid-run for the run's reply, so they aren't tucked under its work", async () => {
  const activities: Array<Record<string, unknown>> = [];
  const responses: Array<string> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  try {
    const { platform } = linearPlatform({
      chat: () =>
        ({
          thread: () => ({
            post: async (message: { markdown: string }) => void responses.push(message.markdown),
          }),
        }) as never,
      adapter: () => ({
        startTyping: async () => {},
        botUserId: "bot",
        linearClient: {
          ...noSession,
          issue: async () => ({ team: Promise.resolve({ key: "ENG" }) }),
          fileUpload: async (_type, filename) => ({
            uploadFile: {
              uploadUrl: "https://upload",
              assetUrl: `https://asset/${filename}`,
              headers: [],
            },
          }),
          createAgentActivity: async (input) => void activities.push(input as never),
        },
      }),
      access: { allowedUserIds: [], allowEveryone: true },
      teams: [],
      defaultRoute: { projectId: "p" },
      onEvent: async () => ({ type: "pending" }),
      log: () => {},
    });
    const file = (filename: string) => ({ data: Buffer.from("x"), filename });
    await platform.post({
      chatThreadKey: THREAD,
      text: "Here they are.",
      files: [file("chart.png"), file("notes.txt")],
      kind: "update",
    });
    // The note is a thought; the files wait for the reply.
    assert.deepStrictEqual(activities, [
      { agentSessionId: "session-1", content: { type: "thought", body: "Here they are." } },
    ]);
    await platform.post({ chatThreadKey: THREAD, text: "files sent" });
    assert.deepStrictEqual(responses, [
      "files sent\n\n![chart.png](https://asset/chart.png)\n\n[notes.txt](https://asset/notes.txt)",
    ]);
    // A run that ends without a reply still shows its files, as the response.
    await platform.post({
      chatThreadKey: THREAD,
      text: "",
      files: [file("late.pdf")],
      kind: "update",
    });
    await platform.setState!(THREAD, "active", "");
    await platform.setState!(THREAD, "active", "");
    assert.deepStrictEqual(responses.slice(1), ["[late.pdf](https://asset/late.pdf)"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("names a HEIC upload as the JPEG image the agent gets", () => {
  // A photo attached to a comment arrives as a plain file link.
  const { text, uploads } = takeUploads(
    "@office what's in this photo?\n\n[linear-bridge-test.heic](https://uploads.linear.app/o/f/linear-bridge-test.heic)",
  );
  assert.strictEqual(text, "@office what's in this photo?\n\n[image: linear-bridge-test.jpg]");
  assert.deepStrictEqual(
    uploadEventFiles(uploads).map((file) => [file.name, file.mimeType]),
    [["linear-bridge-test.jpg", "image/jpeg"]],
  );
});

it("tells the agent reactions don't show on Linear instead of adding one", async () => {
  const createReaction = vi.fn(async () => ({}));
  const { platform } = linearPlatform({
    chat: () => undefined,
    adapter: () => ({
      startTyping: async () => {},
      botUserId: "bot",
      linearClient: {
        ...noSession,
        issue: async () => ({}),
        fileUpload: async () => ({}),
        createReaction,
      } as never,
    }),
    access: { allowedUserIds: [], allowEveryone: true },
    teams: [],
    defaultRoute: { projectId: "p" },
    onEvent: async () => ({ type: "pending" }),
    log: () => {},
  });
  const instead = await reactOn([platform], {
    chatThreadKey: "linear:issue-1",
    messageId: "1700000000.000100",
    emoji: "eyes",
  });
  assert.strictEqual(instead, REACTIONS_UNSEEN);
  assert.strictEqual(createReaction.mock.calls.length, 0);
});

const commentPayload = (data: Record<string, unknown>, action = "create") =>
  JSON.stringify({ type: "Comment", action, webhookTimestamp: 1_800_000_000_000, data });

it("reads a person's new comment from Linear's webhook, and nothing else", () => {
  const data = {
    id: "c-9",
    issueId: "issue-1",
    userId: "user-1",
    user: { name: "Ada" },
    body: "for the record: staging is down",
  };
  assert.deepStrictEqual(commentOf(commentPayload({ ...data, parentId: null })), {
    id: "c-9",
    issueId: "issue-1",
    userId: "user-1",
    name: "Ada",
    body: "for the record: staging is down",
    parentId: undefined,
  });
  assert.isUndefined(commentOf(commentPayload(data, "update")));
  assert.isUndefined(commentOf(commentPayload({ ...data, botActor: { name: "GitHub" } })));
  assert.isUndefined(commentOf(commentPayload({ ...data, issueId: null })));
  assert.isUndefined(commentOf("not json"));
  const event = commentEvent(commentOf(commentPayload(data))!);
  assert.include(event, {
    eventId: "linear:c-9",
    chatThreadKey: "linear:issue-1",
    addressed: false,
    contextOnly: true,
  });
});

it("hands a signed new comment over without waiting, and an unsigned one to the adapter", async () => {
  const secret = "webhook-secret";
  const NOW = 1_800_000_000_000;
  const comments: Array<LinearComment> = [];
  const forwarded: Array<string> = [];
  let release!: () => void;
  const handle = handlingLinearEvents(
    async (request) => {
      forwarded.push(await request.text());
      return new Response("adapter");
    },
    {
      secret,
      now: () => NOW,
      log: () => {},
      onStop: async () => {},
      // Still waiting out its grace when the webhook answers.
      onComment: (comment) =>
        new Promise<void>((resolve) => {
          comments.push(comment);
          release = resolve;
        }),
    },
  );
  const body = commentPayload({ id: "c-9", issueId: "issue-1", userId: "user-1", body: "fyi" });
  const send = (signature: string) =>
    handle(
      new Request("http://127.0.0.1/linear/webhook", {
        method: "POST",
        body,
        headers: { "linear-signature": signature },
      }),
    );
  const response = await send(NodeCrypto.createHmac("sha256", secret).update(body).digest("hex"));
  assert.strictEqual(await response.text(), "OK");
  assert.deepStrictEqual(
    comments.map((comment) => comment.id),
    ["c-9"],
  );
  release();
  await send("0".repeat(64));
  assert.lengthOf(comments, 1);
  assert.deepStrictEqual(forwarded, [body]);
});

it("keeps a plain comment as context once a session hasn't claimed it, and never a session's own", async () => {
  const events: Array<InboundEvent> = [];
  const handled = new Set<string>();
  const { deliver, comment } = linearPlatform({
    chat: () => ({ thread: () => ({ subscribe: async () => {} }) }) as never,
    adapter: () => ({
      startTyping: async () => {},
      botUserId: "bot",
      linearClient: {
        ...noSession,
        issue: async () => ({ team: Promise.resolve({ key: "ENG" }) }),
        fileUpload: async () => ({}),
      } as never,
    }),
    access: { allowedUserIds: [], allowEveryone: true },
    teams: [],
    defaultRoute: { projectId: "p" },
    botName: "office",
    commentGrace: async () => {},
    isHandled: (eventId) => handled.has(eventId),
    onEvent: async (event) => {
      events.push(event);
      return { type: "pending" };
    },
    log: () => {},
  });
  const plain = (id: string, body: string, extra: Partial<LinearComment> = {}): LinearComment => ({
    id,
    issueId: "issue-1",
    userId: "user-1",
    name: "Ada",
    body,
    ...extra,
  });
  // Session 1 opened from comment c-1.
  await deliver({ id: THREAD } as Thread, message("c-1"), undefined, "mention");
  events.length = 0;
  await comment(plain("c-1", "@office fix the flaky test"));
  await comment(plain("c-2", "Hey @Office, look"));
  await comment(plain("c-3", "under the session", { parentId: "c-1" }));
  handled.add("linear:c-4");
  await comment(plain("c-4", "a prompt the session already took"));
  await comment(plain("c-5", "mine", { userId: "bot" }));
  assert.deepStrictEqual(events, []);

  await comment(
    plain("c-6", "fyi: staging is down ![shot](https://uploads.linear.app/a/shot.png)"),
  );
  assert.lengthOf(events, 1);
  assert.include(events[0], { eventId: "linear:c-6", contextOnly: true, addressed: false });
  assert.strictEqual(events[0]!.text, "fyi: staging is down [image: shot]");
});

it("creates an issue and opens a session for an orchestrator, and ignores that session's own announcement", async () => {
  const calls: Array<string> = [];
  const thoughts: Array<string> = [];
  const events: Array<InboundEvent> = [];
  const kept = new Map<string, string>();
  const issue = {
    id: "issue-9",
    identifier: "ENG-9",
    url: "https://linear.app/example/issue/ENG-9",
    team: Promise.resolve({ key: "ENG" }),
  };
  const parts = linearPlatform({
    chat: () => ({ thread: () => ({ subscribe: async () => {} }) }) as never,
    adapter: () => ({
      startTyping: async (thread: string, status?: string) =>
        void thoughts.push(`${thread} ${status}`),
      botUserId: "bot",
      linearClient: {
        ...noSession,
        fileUpload: async () => ({}),
        issue: async (id: string) => {
          calls.push(`issue ${id}`);
          return issue;
        },
        teams: async ({ filter }: { filter: { key: { eq: string } } }) => {
          calls.push(`teams ${filter.key.eq}`);
          return { nodes: [{ id: "team-1", key: filter.key.eq }] };
        },
        createIssue: async (input: { teamId: string; title: string; description?: string }) => {
          calls.push(`create ${input.teamId} ${input.title} ${input.description}`);
          return { issueId: "issue-9" };
        },
        agentSessionCreateOnIssue: async ({ issueId }: { issueId: string }) => {
          calls.push(`session ${issueId}`);
          return { agentSessionId: "session-9" };
        },
      },
    }),
    access: { allowedUserIds: [], allowEveryone: true },
    teams: [],
    defaultRoute: { projectId: "p" },
    onEvent: async (event) => {
      events.push(event);
      return { type: "pending" };
    },
    log: () => {},
    sessions: { get: (key) => kept.get(key), set: (key, id) => void kept.set(key, id) },
  });
  const created = await parts.createIssue({ team: "eng", title: "Fix it", description: "Why" });
  assert.deepStrictEqual(created, {
    issueId: "issue-9",
    identifier: "ENG-9",
    url: "https://linear.app/example/issue/ENG-9",
    teamKey: "ENG",
  });
  const sessionThread = await parts.openSession(created);
  assert.strictEqual(sessionThread, "linear:issue-9:s:session-9");
  assert.deepStrictEqual(calls, [
    "teams ENG",
    "create team-1 Fix it Why",
    "issue issue-9",
    "session issue-9",
  ]);
  // Answers go to the new session, which says something at once.
  assert.strictEqual(kept.get("linear:issue-9"), sessionThread);
  assert.deepStrictEqual(thoughts, [`${sessionThread} Working in T3`]);
  assert.include(parts.workNote(created, "key-9"), "Chat key: key-9");
  assert.include(parts.workNote(created, "key-9"), "ENG-9");

  // Linear announces the session the bridge opened: not a prompt. A prompt in it later is.
  const announcement = new Message({
    ...message("x"),
    id: "agent-session-session-9",
    threadId: sessionThread,
  });
  await parts.deliver({ id: sessionThread } as Thread, announcement, undefined, "subscribed");
  assert.lengthOf(events, 0);
  const prompt = new Message({ ...message("x"), id: "c-20", threadId: sessionThread });
  await parts.deliver({ id: sessionThread } as Thread, prompt, undefined, "subscribed");
  assert.deepStrictEqual(
    events.map((event) => event.eventId),
    ["linear:c-20"],
  );
});
