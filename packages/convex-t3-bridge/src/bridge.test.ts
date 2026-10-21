import { defineSchema, defineTable, httpRouter, makeFunctionReference } from "convex/server";
import type { GenericDatabaseReader, GenericDataModel } from "convex/server";
import { v } from "convex/values";
import { defineTestApp } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { T3Bridge } from "./client/index.js";
import { internal } from "./component/_generated/api.js";
import type { ComponentApi } from "./component/_generated/component.js";
import type { Id } from "./component/_generated/dataModel.js";
import { T3McpClient, T3McpError, type ThreadItem } from "./component/t3Mcp.js";
import crons from "./component/crons.js";
import componentTest from "./test.js";
import {
  vT3BridgeEvent,
  vConfig,
  type Config,
  type T3BridgeEvent,
  type Launch,
} from "./validators.js";

const configValue: Config = {
  t3McpUrl: "https://t3.test/custom/mcp",
  t3McpToken: "fake-t3-token",
  replyKeySecret: "fake-reply-secret",
};
const hostSchema = defineSchema({
  received: defineTable({ event: vT3BridgeEvent }),
  flags: defineTable({ rejectDurable: v.boolean(), rejectActivity: v.boolean() }),
});
const app = defineTestApp({
  schema: hostSchema,
  components: {
    t3Bridge: {
      register(t: Parameters<typeof componentTest.register>[0], name: string) {
        return t.registerComponent<ComponentApi & typeof internal>(
          name,
          componentTest.schema,
          componentTest.modules,
        );
      },
    },
  },
});
const component = app.components.t3Bridge;
const bridge = new T3Bridge(component, {
  config: makeFunctionReference<"query", Record<string, never>, Config>("host:config"),
  onEvent: makeFunctionReference<"mutation", { event: T3BridgeEvent }, null>("host:onEvent"),
});
const http = httpRouter();
bridge.registerReplyRoute(http, {
  path: "/reply",
  authorize: (request) => request.headers.get("authorization") === "Bearer host-test",
});
const { api: host, createTest } = app.defineModules({
  http: { default: http },
  host: {
    config: app.internalQuery({ args: {}, returns: vConfig, handler: () => configValue }),
    onEvent: app.internalMutation({
      args: { event: vT3BridgeEvent },
      returns: v.null(),
      handler: async (ctx, { event }) => {
        const flags = await ctx.db.query("flags").first();
        if (event.type === "activity" ? flags?.rejectActivity : flags?.rejectDurable)
          throw new Error("HOST_CALLBACK_FAILED");
        await ctx.db.insert("received", { event });
        return null;
      },
    }),
    send: app.mutation({
      args: {
        conversationKey: v.optional(v.string()),
        text: v.optional(v.string()),
        clientRequestId: v.optional(v.string()),
        launch: v.optional(v.boolean()),
        attachments: v.optional(
          v.array(
            v.object({
              filename: v.string(),
              mimeType: v.string(),
              url: v.string(),
              byteSize: v.number(),
              sha256: v.string(),
            }),
          ),
        ),
      },
      returns: v.string(),
      handler: async (ctx, args): Promise<string> =>
        bridge.send(ctx, {
          conversationKey: args.conversationKey ?? "conversation.1",
          text: args.text ?? "hello",
          clientRequestId: args.clientRequestId,
          attachments: args.attachments,
          launch: args.launch === false ? undefined : launch,
        }),
    }),
    cancel: app.mutation({
      args: { conversationKey: v.optional(v.string()) },
      returns: v.null(),
      handler: async (ctx, args): Promise<null> =>
        bridge.cancel(ctx, { conversationKey: args.conversationKey ?? "conversation.1" }),
    }),
    rotate: app.mutation({
      args: { conversationKey: v.optional(v.string()) },
      returns: v.string(),
      handler: async (ctx, args): Promise<string> =>
        bridge.rotateReplyKey(ctx, { conversationKey: args.conversationKey ?? "conversation.1" }),
    }),
    importThread: app.action({
      args: { conversationKey: v.string(), threadId: v.string() },
      returns: v.null(),
      handler: async (ctx, args): Promise<null> => bridge.importThread(ctx, args),
    }),
    get: app.query({
      args: { conversationKey: v.string() },
      handler: (ctx, args) => bridge.getConversation(ctx, args),
    }),
    events: app.query({
      args: {},
      returns: v.array(vT3BridgeEvent),
      handler: async (ctx) => (await ctx.db.query("received").collect()).map((row) => row.event),
    }),
  },
});
const launch: Launch = {
  projectId: "project",
  title: "Test conversation",
  instructions: "Standing instructions",
  modelSelection: { instanceId: "codex", model: "test-model" },
  workspaceStrategy: { type: "worktree", baseRef: "dev", startFromOrigin: false },
};
type Test = ReturnType<typeof createTest>;
type Call = { name: string; args: Record<string, unknown> };
const callSchema = z.object({
  method: z.string(),
  params: z.unknown().optional(),
});
const calls: Call[] = [];
let tools: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>;
let upload: () => Response | Promise<Response>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  calls.length = 0;
  tools = () => {
    throw new Error("Unexpected tool");
  };
  upload = () => new Response(null, { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).startsWith("https://files.test/")) return new Response("abc");
      if (String(url).includes("/upload/")) return upload();
      expect(String(url)).toBe(configValue.t3McpUrl);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${configValue.t3McpToken}`,
      );
      const request = callSchema.parse(JSON.parse(String(init?.body)));
      if (request.method !== "tools/call") return Response.json({ result: {} });
      const params = z
        .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) })
        .parse(request.params);
      const call = { name: params.name, args: params.arguments };
      calls.push(call);
      // Real T3 rejects these as invalid params (-32602), which the watcher treats as permanent.
      const { limit, runLimit } = call.args;
      if (
        call.name === "t3_thread_read" &&
        ((typeof limit === "number" && limit > 100) ||
          (typeof runLimit === "number" && runLimit > 50))
      )
        return Response.json({ error: { code: -32602, message: "Invalid params" } });
      const value = await tools(call.name, call.args);
      return Response.json({ result: { structuredContent: value } });
    }),
  );
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function page(
  input: {
    status?: string;
    items?: ThreadItem[];
    runId?: string;
    hasMore?: boolean;
    nextPosition?: number | null;
    startedAt?: string | null;
    runs?: { runId: string; status: string }[];
  } = {},
) {
  const status = input.status ?? "completed";
  const runId = input.runId ?? "run-1";
  return {
    thread: {
      threadId: "thread-1",
      projectId: "project",
      status,
      activeRunId: ["running", "preparing", "starting", "waiting"].includes(status) ? runId : null,
      latestRunId: runId,
    },
    recentRuns: (input.runs ?? [{ runId, status }]).map((run, index) => ({
      ...run,
      ordinal: index + 1,
      startedAt: input.startedAt === undefined ? new Date().toISOString() : input.startedAt,
    })),
    items: input.items ?? [],
    nextPosition: input.nextPosition ?? null,
    hasMore: input.hasMore ?? false,
  };
}
function item(position: number, text = "Answer", runId = "run-1"): ThreadItem {
  return {
    position,
    itemId: `item-${position}`,
    runId,
    createdBy: "agent",
    creationSource: "provider",
    type: "assistant_message",
    status: "completed",
    title: null,
    text,
    updatedAt: new Date().toISOString(),
    textTruncated: false,
    nextTextOffset: null,
  };
}
function launched() {
  return { threadId: "thread-1", projectId: "project", runId: "run-1", status: "preparing" };
}
function sent(runId = "run-2") {
  return { threadId: "thread-1", runId, status: "running" };
}
async function seed(t: Test, attachments = false) {
  const id = await t.mutation(host.host.send, { attachments: attachments ? [file()] : undefined });
  const claim = await t.mutation(component.bridge.claimDelivery, {
    outboxId: await outboxId(t, id),
  });
  if (!claim) throw new Error("Missing delivery claim");
  await t.mutation(component.bridge.deferDelivery, {
    outboxId: claim.row._id,
    token: claim.token,
    delay: 0,
  });
  return { outboxId: claim.row._id, conversationId: claim.conversation._id };
}
// Generated component APIs serialize IDs as strings. Normalize before calling
// the private, component-local functions exercised directly by these tests.
async function outboxId(t: Test, value: string): Promise<Id<"outbox">> {
  return t.run(async (ctx) => {
    const db: GenericDatabaseReader<GenericDataModel> = ctx.db;
    const id = db.normalizeId("outbox", value);
    if (!id) throw new Error("Invalid component outbox ID");
    return id;
  });
}
function file() {
  return {
    filename: "log.txt",
    mimeType: "text/plain",
    url: "https://files.test/log",
    byteSize: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  };
}
async function bind(t: Test, fixture: Awaited<ReturnType<typeof seed>>, runId = "run-1") {
  const claim = await t.mutation(component.bridge.claimDelivery, { outboxId: fixture.outboxId });
  if (!claim) throw new Error("Missing claim");
  await t.mutation(component.bridge.acceptDelivery, {
    outboxId: fixture.outboxId,
    token: claim.token,
    threadId: "thread-1",
    runId,
    stage: "delivered",
  });
}

describe("component delivery and watcher", () => {
  it("launches once, persists a key before external IO, and sends standing instructions only once", async () => {
    const t = createTest();
    const fixture = await seed(t);
    const launchReached = Promise.withResolvers<void>();
    const releaseLaunch = Promise.withResolvers<void>();
    let key = "";
    tools = async (name, args) => {
      if (name === "t3_thread_list") return { threads: [], nextCursor: null };
      if (name === "t3_thread_launch") {
        key = String(args.message).match(/t3_reply_key: (\S+)/)?.[1] ?? "";
        expect(args.message).toContain("Standing instructions");
        launchReached.resolve();
        await releaseLaunch.promise;
        return launched();
      }
      if (name === "t3_thread_send") {
        expect(args.message).not.toContain("Standing instructions");
        expect(args.message).toContain(key);
        expect(args.clientRequestId).toMatch(/^t3-bridge:/);
        return sent();
      }
      throw new Error(name);
    };
    const delivering = t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    await launchReached.promise;
    expect(await t.query(component.bridge.authorizeReply, { replyKey: key })).toBe(
      "conversation.1",
    );
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    expect(calls.filter((call) => call.name === "t3_thread_launch")).toHaveLength(1);
    releaseLaunch.resolve();
    await delivering;
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    const next = await t.mutation(host.host.send, { clientRequestId: "second" });
    const repeated = await t.mutation(host.host.send, { clientRequestId: "second" });
    expect(repeated).toBe(next);
    await t.action(component.actions.deliver, { outboxId: await outboxId(t, next) });
    expect(calls.map((call) => call.name)).toEqual([
      "t3_thread_list",
      "t3_thread_launch",
      "t3_thread_send",
    ]);
    tools = () =>
      page({
        runId: "run-2",
        runs: [
          { runId: "run-1", status: "completed" },
          { runId: "run-2", status: "completed" },
        ],
        items: [item(1, "first", "run-1"), item(2, "second", "run-2")],
      });
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    expect((await t.query(host.host.events, {})).map((event) => event.type)).toEqual([
      "turnStarted",
      "assistantMessage",
      "turnEnded",
      "turnStarted",
      "assistantMessage",
      "turnEnded",
    ]);
    expect(
      (await t.query(host.host.events, {}))
        .filter((event) => event.type === "turnStarted")
        .every((event) => event.origin === "send"),
    ).toBe(true);
  });

  it("recovers a lost launch by marker instead of resending the initial message", async () => {
    const t = createTest();
    const fixture = await seed(t);
    let title = "";
    tools = (name, args) => {
      if (name === "t3_thread_list")
        return {
          threads: title
            ? [
                {
                  threadId: "thread-1",
                  title,
                  status: "completed",
                  latestRunId: "run-1",
                  updatedAt: new Date().toISOString(),
                },
              ]
            : [],
          nextCursor: null,
        };
      if (name === "t3_thread_launch") {
        title = String(args.title);
        throw new Error("connection lost after acceptance");
      }
      throw new Error(name);
    };
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    vi.setSystemTime(Date.now() + 4_000);
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    expect(calls.filter((call) => call.name === "t3_thread_launch")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "t3_thread_send")).toHaveLength(0);
    expect(await t.query(host.host.get, { conversationKey: "conversation.1" })).toMatchObject({
      threadId: "thread-1",
    });
  });

  it("holds first-message attachments and successors until workspace preparation completes", async () => {
    const t = createTest();
    const fixture = await seed(t, true);
    let ready = false;
    tools = (name) => {
      if (name === "t3_thread_list") return { threads: [], nextCursor: null };
      if (name === "t3_thread_launch") return launched();
      if (name === "t3_thread_read")
        return page({
          status: ready ? "running" : "preparing",
          startedAt: ready ? new Date().toISOString() : null,
        });
      if (name === "t3_attachment_prepare_upload")
        return { attachmentId: "attachment", relativeUrl: "/upload/a", expiresAt: 9_000_000 };
      if (name === "t3_thread_send_attachments") return sent();
      throw new Error(name);
    };
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    const successor = await t.mutation(host.host.send, {});
    await t.action(component.actions.deliver, { outboxId: await outboxId(t, successor) });
    expect(calls.some((call) => call.name === "t3_attachment_prepare_upload")).toBe(false);
    ready = true;
    vi.setSystemTime(Date.now() + 3_000);
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    expect(calls.filter((call) => call.name === "t3_thread_send_attachments")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "t3_thread_launch")).toHaveLength(1);
  });

  it("retries partial uploads but never retries an uncertain attachment send", async () => {
    const t = createTest();
    const fixture = await seed(t, true);
    let failedUpload = false;
    upload = () => {
      if (!failedUpload) {
        failedUpload = true;
        throw new Error("upload failed");
      }
      return new Response(null, { status: 200 });
    };
    tools = (name) => {
      if (name === "t3_thread_list") return { threads: [], nextCursor: null };
      if (name === "t3_thread_launch") return launched();
      if (name === "t3_thread_read") return page();
      if (name === "t3_attachment_prepare_upload")
        return { attachmentId: "attachment", relativeUrl: "/upload/a", expiresAt: 9_000_000 };
      if (name === "t3_thread_send_attachments") throw new Error("lost attachment response");
      throw new Error(name);
    };
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    vi.setSystemTime(Date.now() + 4_000);
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    vi.setSystemTime(Date.now() + 60_000);
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    expect(calls.filter((call) => call.name === "t3_attachment_prepare_upload")).toHaveLength(2);
    expect(calls.filter((call) => call.name === "t3_thread_send_attachments")).toHaveLength(1);
    expect(
      (await t.query(host.host.events, {})).filter((event) => event.type === "deliveryFailed"),
    ).toHaveLength(1);
  });

  it("fails a preparation timeout once without relaunching or uploading", async () => {
    const t = createTest();
    const fixture = await seed(t, true);
    tools = (name) => {
      if (name === "t3_thread_list") return { threads: [], nextCursor: null };
      if (name === "t3_thread_launch") return launched();
      if (name === "t3_thread_read") return page({ status: "preparing", startedAt: null });
      throw new Error(name);
    };
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    expect(calls.filter((call) => call.name === "t3_thread_launch")).toHaveLength(1);
    expect(await t.query(host.host.events, {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "deliveryFailed",
          code: "T3_MCP_WORKSPACE_PREPARATION_TIMEOUT",
        }),
      ]),
    );
  });

  it("uses one fenced watcher, expands final text, and commits durable callbacks in order once", async () => {
    const t = createTest();
    const fixture = await seed(t);
    await bind(t, fixture);
    let continued = false;
    tools = (name, args) => {
      if (name !== "t3_thread_read") throw new Error(name);
      if (args.itemId) {
        continued = true;
        return page({ items: [{ ...item(1, "tail"), nextTextOffset: null }] });
      }
      return page({ items: [{ ...item(1, "head "), textTruncated: true, nextTextOffset: 5 }] });
    };
    const lease = await t.mutation(component.watcher.acquire, {
      conversationId: fixture.conversationId,
    });
    expect(lease).not.toBeNull();
    expect(
      await t.mutation(component.watcher.acquire, { conversationId: fixture.conversationId }),
    ).toBeNull();
    vi.setSystemTime(Date.now() + 60_001);
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    expect(continued).toBe(true);
    expect((await t.query(host.host.events, {})).map((event) => event.type)).toEqual([
      "turnStarted",
      "assistantMessage",
      "turnEnded",
    ]);
    expect((await t.query(host.host.events, {})).at(-1)).toMatchObject({ finalText: "head tail" });
    expect(await t.query(host.host.get, { conversationKey: "conversation.1" })).toMatchObject({
      position: 1,
    });
  });

  it("rolls back the cursor and durable event when the host callback rejects, but isolates activity", async () => {
    const t = createTest();
    const fixture = await seed(t);
    await bind(t, fixture);
    const flag = await t.run((ctx) =>
      ctx.db.insert("flags", { rejectDurable: true, rejectActivity: true }),
    );
    tools = () => page({ items: [{ ...item(1, "command"), type: "tool_call" }, item(2)] });
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    expect(await t.query(host.host.get, { conversationKey: "conversation.1" })).toMatchObject({
      position: 0,
    });
    await t.run((ctx) => ctx.db.patch(flag, { rejectDurable: false }));
    vi.setSystemTime(Date.now() + 4_000);
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    const expectedActivityFailure = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    } finally {
      expectedActivityFailure.mockRestore();
    }
    expect((await t.query(host.host.events, {})).map((event) => event.type)).toEqual([
      "turnStarted",
      "assistantMessage",
      "turnEnded",
    ]);
  });

  it("stops permanent watcher errors, backs off retryable errors, and resets after a new send", async () => {
    const t = createTest();
    const fixture = await seed(t);
    await bind(t, fixture);
    const normalFetch = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 503 })),
    );
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    expect(
      await t.mutation(component.watcher.acquire, { conversationId: fixture.conversationId }),
    ).toBeNull();
    expect(
      (await t.query(host.host.events, {})).filter((event) => event.type === "watchFailed"),
    ).toHaveLength(0);
    vi.setSystemTime(Date.now() + 3_000);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 401 })),
    );
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    expect(
      (await t.query(host.host.events, {})).filter((event) => event.type === "watchFailed"),
    ).toHaveLength(1);
    expect(
      await t.mutation(component.watcher.acquire, { conversationId: fixture.conversationId }),
    ).toBeNull();
    vi.stubGlobal("fetch", normalFetch);
    tools = (name) => {
      if (name === "t3_thread_send") return sent();
      throw new Error(name);
    };
    const next = await t.mutation(host.host.send, {});
    await t.action(component.actions.deliver, { outboxId: await outboxId(t, next) });
    expect(
      await t.mutation(component.watcher.acquire, { conversationId: fixture.conversationId }),
    ).not.toBeNull();
  });

  it("discovers a completed background wake through sweep", async () => {
    const t = createTest();
    const fixture = await seed(t);
    await bind(t, fixture);
    tools = (name) => {
      if (name === "t3_thread_list")
        return {
          threads: [
            {
              threadId: "thread-1",
              title: "thread",
              status: "completed",
              latestRunId: "wake",
              updatedAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        };
      if (name === "t3_thread_read")
        return page({ runId: "wake", items: [item(1, "wake answer", "wake")] });
      throw new Error(name);
    };
    await t.action(component.actions.sweep, {});
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    expect(await t.query(host.host.events, {})).toContainEqual({
      type: "turnStarted",
      conversationKey: "conversation.1",
      threadId: "thread-1",
      runId: "wake",
      origin: "background",
    });
  });

  it("skips canceled pending rows and interrupts a launch accepted during cancellation", async () => {
    const t = createTest();
    const fixture = await seed(t, true);
    const launchReached = Promise.withResolvers<void>();
    const releaseLaunch = Promise.withResolvers<void>();
    tools = async (name) => {
      if (name === "t3_thread_list") return { threads: [], nextCursor: null };
      if (name === "t3_thread_launch") {
        launchReached.resolve();
        await releaseLaunch.promise;
        return launched();
      }
      if (name === "t3_thread_read") return page({ status: "preparing", startedAt: null });
      if (name === "t3_thread_interrupt")
        return { threadId: "thread-1", runId: "run-1", status: "interrupt_requested" };
      throw new Error(name);
    };
    const delivering = t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    await launchReached.promise;
    await t.mutation(host.host.cancel, {});
    releaseLaunch.resolve();
    await delivering;
    await t.mutation(component.bridge.skipCanceled, { conversationId: fixture.conversationId });
    await t.action(component.actions.interrupt, { conversationId: fixture.conversationId });
    expect(calls.find((call) => call.name === "t3_thread_interrupt")?.args).toMatchObject({
      threadId: "thread-1",
      runId: "run-1",
    });
    await t.action(component.actions.deliver, { outboxId: fixture.outboxId });
    expect(calls.filter((call) => call.name === "t3_thread_launch")).toHaveLength(1);
  });

  it("imports at the last item's position when nextPosition is null and does not replay history", async () => {
    const t = createTest();
    tools = () => page({ items: [item(6, "old")], nextPosition: null });
    await t.action(host.host.importThread, { conversationKey: "adopted", threadId: "thread-1" });
    expect(await t.query(host.host.get, { conversationKey: "adopted" })).toMatchObject({
      position: 6,
    });
    expect(await t.query(host.host.events, {})).toEqual([]);
  });

  it("fences a stale watcher when a conversation adopts another thread", async () => {
    const t = createTest();
    const fixture = await seed(t);
    await bind(t, fixture);
    const acquired = await t.mutation(component.watcher.acquire, {
      conversationId: fixture.conversationId,
    });
    if (!acquired) throw new Error("No watcher lease");
    const handles = {
      config: acquired.conversation.config,
      onEvent: acquired.conversation.onEvent,
    };
    await t.mutation(component.bridge.beginImport, {
      ...handles,
      conversationKey: "conversation.1",
      threadId: "replacement",
    });
    const { textTruncated: _truncated, nextTextOffset: _offset, ...staleItem } = item(999, "stale");
    expect(
      await t.mutation(component.watcher.applyBatch, {
        conversationId: fixture.conversationId,
        generation: acquired.conversation.generation,
        token: acquired.token,
        threadId: "thread-1",
        position: 999,
        threadStatus: "completed",
        runs: [{ runId: "run-1", status: "completed" }],
        items: [staleItem],
        hasMore: false,
      }),
    ).toBe(false);
    expect(
      (await t.query(host.host.events, {})).some((event) => event.type === "assistantMessage"),
    ).toBe(false);
  });

  it("retains final text across polling pages before a turn becomes terminal", async () => {
    const t = createTest();
    const fixture = await seed(t);
    await bind(t, fixture);
    let completed = false;
    tools = () =>
      completed ? page() : page({ status: "running", items: [item(1, "Already archived")] });
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    completed = true;
    await t.action(component.actions.watch, { conversationId: fixture.conversationId });
    expect((await t.query(host.host.events, {})).at(-1)).toMatchObject({
      type: "turnEnded",
      finalText: "Already archived",
    });
  });

  it("registers a five-second component cron", () => {
    if (!("export" in crons) || typeof crons.export !== "function")
      throw new Error("Cron metadata is unavailable");
    expect(JSON.parse(z.string().parse(crons.export()))).toMatchObject({
      "discover background turns and recover deliveries": {
        schedule: { type: "interval", seconds: 5 },
      },
    });
  });
});

describe("reply intake in the host", () => {
  it("authorizes before component access, advertises reply, and rejects oversized bodies before parsing", async () => {
    const t = createTest();
    expect((await t.fetch("/reply", { method: "POST", body: "{}" })).status).toBe(401);
    const list = await t.fetch("/reply", rpc("tools/list"));
    expect(await list.json()).toMatchObject({ result: { tools: [{ name: "reply" }] } });
    const oversized = await t.fetch("/reply", {
      ...rpc("tools/list"),
      headers: {
        authorization: "Bearer host-test",
        "content-length": String(29 * 1024 * 1024 + 1),
      },
    });
    expect(oversized.status).toBe(413);
    let canceled = false;
    const streamRequest = {
      method: "POST",
      headers: { authorization: "Bearer host-test" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(29 * 1024 * 1024 + 1));
        },
        cancel() {
          canceled = true;
        },
      }),
      duplex: "half",
    };
    const streamed = await t.fetch("/reply", streamRequest);
    expect(streamed.status).toBe(413);
    expect(canceled).toBe(true);
  });

  it("checks conversation HMAC and nonce, rejects duplicate/rate-limited replies, and accepts a final answer", async () => {
    const t = createTest();
    const key = await t.mutation(host.host.rotate, {});
    expect(await reply(t, { reply_key: `${key}x`, text: "no" })).toMatchObject({
      result: { isError: true },
    });
    expect(
      await reply(t, { reply_key: key.replace("conversation.1", "another"), text: "no" }),
    ).toMatchObject({ result: { isError: true } });
    expect(await reply(t, { reply_key: key, text: "progress" })).toMatchObject({
      result: { structuredContent: { ok: true } },
    });
    expect(await reply(t, { reply_key: key, text: "progress", final: true })).toMatchObject({
      result: { isError: true },
    });
    expect(await reply(t, { reply_key: key, text: "too soon" })).toMatchObject({
      result: { isError: true },
    });
    expect(await reply(t, { reply_key: key, text: "final", final: true })).toMatchObject({
      result: { structuredContent: { ok: true } },
    });
    const rotated = await t.mutation(host.host.rotate, {});
    expect(rotated).not.toBe(key);
    expect(await reply(t, { reply_key: key, text: "old" })).toMatchObject({
      result: { isError: true },
    });
    expect(
      (await t.query(host.host.events, {})).filter((event) => event.type === "reply"),
    ).toHaveLength(2);
  });

  it("stores base64 files in host storage, includes IDs in the event, and cleans rejected files", async () => {
    const t = createTest();
    const key = await t.mutation(host.host.rotate, {});
    expect(
      await reply(t, {
        reply_key: key,
        text: "file",
        files: [{ filename: "../log.txt", mimeType: "text/plain", data: btoa("abc") }],
      }),
    ).toMatchObject({ result: { structuredContent: { ok: true } } });
    const event = (await t.query(host.host.events, {})).find((entry) => entry.type === "reply");
    if (!event || event.type !== "reply" || !event.files[0]) throw new Error("Missing file event");
    expect(event.files[0]).toMatchObject({
      filename: ".._log.txt",
      byteSize: 3,
      sha256: file().sha256,
    });
    expect(
      await reply(t, {
        reply_key: key,
        text: "bad",
        files: [{ filename: "bad", mimeType: "text/plain", data: "not base64" }],
      }),
    ).toMatchObject({ result: { isError: true } });
    expect(await t.run((ctx) => ctx.db.system.query("_storage").collect())).toHaveLength(1);
    expect(
      await reply(t, {
        reply_key: key,
        text: "file",
        files: [{ filename: "another", mimeType: "text/plain", data: btoa("abc") }],
      }),
    ).toMatchObject({ result: { isError: true } });
    expect(await t.run((ctx) => ctx.db.system.query("_storage").collect())).toHaveLength(1);
  });
});

describe("MCP failure boundary", () => {
  it("rejects isError before decoding its otherwise-valid structured result and checks upload origin", async () => {
    const client = new T3McpClient(
      configValue,
      vi.fn<typeof fetch>(async (_url, init) => {
        const input = callSchema.parse(JSON.parse(String(init?.body)));
        return Response.json(
          input.method === "tools/call"
            ? {
                result: {
                  isError: true,
                  structuredContent: { ...sent(), code: "capability_denied" },
                },
              }
            : { result: {} },
        );
      }),
    );
    await expect(client.sendThread("thread-1", "hello", "stable")).rejects.toMatchObject({
      code: "T3_MCP_CAPABILITY_DENIED",
      retryable: false,
    });
    await expect(
      client.upload("https://evil.test/upload", new ArrayBuffer(1), "text/plain"),
    ).rejects.toBeInstanceOf(T3McpError);
  });
});

function rpc(method: string, args?: unknown): RequestInit {
  return {
    method: "POST",
    headers: { authorization: "Bearer host-test", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: args }),
  };
}
async function reply(t: Test, args: unknown): Promise<unknown> {
  const response = await t.fetch("/reply", rpc("tools/call", { name: "reply", arguments: args }));
  return response.json();
}
