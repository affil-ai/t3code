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
  linearPlatform,
  mimeTypeOf,
  uploadToLinear,
} from "./platform.ts";

const THREAD = "linear:issue-1:s:session-1";

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
