import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import { conversationFields, outboxFields } from "./schema.js";
import { vHandles, vSend, vStoredFile } from "../validators.js";
import { isConfigHandle } from "./handles.js";
import { conversationFromKey, replyKey, timingSafeEqual } from "./replyKey.js";
import { emit } from "./events.js";

const conversationDoc = v.object({
  ...conversationFields,
  _id: v.id("conversations"),
  _creationTime: v.number(),
});
const outboxDoc = v.object({ ...outboxFields, _id: v.id("outbox"), _creationTime: v.number() });
const leaseArgs = { outboxId: v.id("outbox"), token: v.string() };

export const getConversation = query({
  args: { conversationKey: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      conversationKey: v.string(),
      threadId: v.optional(v.string()),
      position: v.number(),
      activeRunId: v.optional(v.string()),
      watchStopped: v.boolean(),
      lastError: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await byKey(ctx, args.conversationKey);
    if (!row) return null;
    return {
      conversationKey: row.conversationKey,
      threadId: row.threadId,
      position: row.position,
      activeRunId: row.activeRunId,
      watchStopped: row.watchStopped,
      lastError: row.lastError,
    };
  },
});

export const send = mutation({
  args: { ...vSend, ...vHandles },
  returns: v.id("outbox"),
  handler: async (ctx, args): Promise<Id<"outbox">> => {
    const conversation = await ensureConversation(ctx, args);
    const requestId = args.clientRequestId ?? crypto.randomUUID();
    const prior = await ctx.db
      .query("outbox")
      .withIndex("by_request", (q) =>
        q.eq("conversationId", conversation._id).eq("clientRequestId", requestId),
      )
      .unique();
    if (prior) return prior._id;
    if (args.launch && !conversation.launch) {
      await ctx.db.patch(conversation._id, {
        launch: args.launch,
        projectId: args.launch.projectId,
      });
    }
    for (const file of args.attachments ?? []) {
      if (
        !Number.isSafeInteger(file.byteSize) ||
        file.byteSize <= 0 ||
        file.byteSize > 20 * 1024 * 1024 ||
        !/^[a-fA-F0-9]{64}$/.test(file.sha256) ||
        !/^https?:\/\//.test(file.url)
      ) {
        throw new ConvexError("T3_BRIDGE_INVALID_ATTACHMENT");
      }
    }
    if (
      (args.attachments ?? []).reduce((total, file) => total + file.byteSize, 0) >
      50 * 1024 * 1024
    ) {
      throw new ConvexError("T3_BRIDGE_ATTACHMENT_TOTAL_TOO_LARGE");
    }
    if ((args.attachments?.length ?? 0) > 10)
      throw new ConvexError("T3_BRIDGE_TOO_MANY_ATTACHMENTS");
    const id = await ctx.db.insert("outbox", {
      conversationId: conversation._id,
      clientRequestId: requestId,
      text: args.text,
      attachments: args.attachments ?? [],
      launch: conversation.launch ?? args.launch,
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      cancelVersion: conversation.cancelVersion,
    });
    await ctx.scheduler.runAfter(0, internal.actions.deliver, { outboxId: id });
    return id;
  },
});

export const rotateReplyKey = mutation({
  args: { conversationKey: v.string(), ...vHandles },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const row = await ensureConversation(ctx, args);
    const nonce = crypto.randomUUID();
    await ctx.db.patch(row._id, { nonce });
    if (!isConfigHandle(row.config)) throw new ConvexError("T3_BRIDGE_INVALID_CONFIG_HANDLE");
    const config = await ctx.runQuery(row.config, {});
    return replyKey(row.conversationKey, nonce, config.replyKeySecret);
  },
});

export const cancel = mutation({
  args: { conversationKey: v.string(), ...vHandles },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ensureConversation(ctx, args);
    const pending = await ctx.db
      .query("outbox")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", row._id).eq("status", "pending"),
      )
      .take(100);
    const inFlight = await ctx.db
      .query("outbox")
      .withIndex("by_conversation_lease", (q) =>
        q.eq("conversationId", row._id).gt("leaseUntil", Date.now()),
      )
      .first();
    for (const outbox of pending) await ctx.db.patch(outbox._id, { status: "skipped" });
    // The version fences every older row, including rows beyond this bounded page.
    await ctx.db.patch(row._id, {
      cancelVersion: row.cancelVersion + 1,
      cancelPending: Boolean(row.threadId || inFlight),
      cancelRunId: row.activeRunId,
      cancelNextAt: 0,
    });
    if (pending.length === 100)
      await ctx.scheduler.runAfter(0, internal.bridge.skipCanceled, { conversationId: row._id });
    await ctx.scheduler.runAfter(0, internal.actions.interrupt, { conversationId: row._id });
    return null;
  },
});

export const skipCanceled = internalMutation({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.conversationId);
    if (!row) return null;
    const pending = await ctx.db
      .query("outbox")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", row._id).eq("status", "pending"),
      )
      .take(100);
    let skipped = 0;
    for (const item of pending) {
      if (item.cancelVersion < row.cancelVersion) {
        await ctx.db.patch(item._id, { status: "skipped" });
        skipped++;
      }
    }
    if (skipped === 100) await ctx.scheduler.runAfter(0, internal.bridge.skipCanceled, args);
    return null;
  },
});

export const beginImport = mutation({
  args: { conversationKey: v.string(), threadId: v.string(), ...vHandles },
  returns: conversationDoc,
  handler: async (ctx, args) => {
    const row = await ensureConversation(ctx, args);
    const pending = await ctx.db
      .query("outbox")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", row._id).eq("status", "pending"),
      )
      .first();
    if (pending || row.importing) throw new ConvexError("T3_BRIDGE_CONVERSATION_BUSY");
    const other = await ctx.db
      .query("conversations")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique();
    if (other && other._id !== row._id) throw new ConvexError("T3_BRIDGE_THREAD_ALREADY_IMPORTED");
    const updated = {
      ...row,
      threadId: args.threadId,
      importing: true,
      generation: row.generation + 1,
      nonce: crypto.randomUUID(),
      watcherToken: undefined,
      watcherLeaseUntil: undefined,
      activeRunId: undefined,
      cancelPending: false,
      instructionsPending: true,
    };
    const { _id, _creationTime, ...fields } = updated;
    await ctx.db.patch(row._id, fields);
    return updated;
  },
});

export const finishImport = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    generation: v.number(),
    threadId: v.string(),
    position: v.number(),
    projectId: v.string(),
    runIds: v.array(v.string()),
    latestRunId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.conversationId);
    if (!row || row.generation !== args.generation || row.threadId !== args.threadId) return null;
    // Tombstones suppress turnStarted/turnEnded for pre-import history.
    for (const runId of args.runIds) {
      const existing = await ctx.db
        .query("runs")
        .withIndex("by_conversation_run", (q) => q.eq("conversationId", row._id).eq("runId", runId))
        .unique();
      if (!existing)
        await ctx.db.insert("runs", {
          conversationId: row._id,
          runId,
          origin: "background",
          status: "imported",
          ended: true,
          finalText: "",
          finalPosition: args.position,
        });
    }
    await ctx.db.patch(row._id, {
      position: args.position,
      projectId: args.projectId,
      importing: false,
      watchStopped: false,
      watchFailures: 0,
      watchNextAt: 0,
      lastError: undefined,
      activeRunId: args.latestRunId,
    });
    return null;
  },
});

export const abortImport = internalMutation({
  args: { conversationId: v.id("conversations"), generation: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.conversationId);
    if (row?.generation === args.generation)
      await ctx.db.patch(row._id, { importing: false, watchStopped: true });
    return null;
  },
});

export const claimDelivery = internalMutation({
  args: { outboxId: v.id("outbox") },
  returns: v.union(
    v.null(),
    v.object({ row: outboxDoc, conversation: conversationDoc, token: v.string() }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outboxId);
    if (
      !row ||
      row.status !== "pending" ||
      row.nextAttemptAt > Date.now() ||
      (row.leaseUntil ?? 0) > Date.now()
    )
      return null;
    const conversation = await ctx.db.get(row.conversationId);
    if (!conversation || conversation.importing || conversation.cancelPending) return null;
    if (row.cancelVersion < conversation.cancelVersion) {
      await ctx.db.patch(row._id, { status: "skipped" });
      return null;
    }
    const first = await ctx.db
      .query("outbox")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", conversation._id).eq("status", "pending"),
      )
      .first();
    if (first?._id !== row._id) return null;
    const inFlight = await ctx.db
      .query("outbox")
      .withIndex("by_conversation_lease", (q) =>
        q.eq("conversationId", conversation._id).gt("leaseUntil", Date.now()),
      )
      .first();
    if (inFlight) return null;
    const token = crypto.randomUUID();
    const updated = {
      ...row,
      token,
      leaseUntil: Date.now() + 60_000,
      launch: row.launch ?? conversation.launch,
      includeInstructions: row.includeInstructions ?? conversation.instructionsPending,
    };
    await ctx.db.patch(row._id, {
      token,
      leaseUntil: updated.leaseUntil,
      launch: updated.launch,
      includeInstructions: updated.includeInstructions,
    });
    return { row: updated, conversation, token };
  },
});

export const deliveryGuard = internalMutation({
  args: {
    ...leaseArgs,
    stage: v.union(v.literal("renew"), v.literal("launch"), v.literal("attachments")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.outboxId);
    const conversation = row ? await ctx.db.get(row.conversationId) : null;
    if (
      !row ||
      !conversation ||
      row.status !== "pending" ||
      row.token !== args.token ||
      row.cancelVersion !== conversation.cancelVersion ||
      conversation.importing
    )
      return false;
    if (args.stage === "attachments" && row.attachmentAttemptedAt !== undefined) return false;
    await ctx.db.patch(row._id, {
      leaseUntil: Date.now() + 60_000,
      ...(args.stage === "launch"
        ? { launchAttemptedAt: row.launchAttemptedAt ?? Date.now() }
        : {}),
      ...(args.stage === "attachments" ? { attachmentAttemptedAt: Date.now() } : {}),
    });
    return true;
  },
});

export const acceptDelivery = internalMutation({
  args: {
    ...leaseArgs,
    threadId: v.string(),
    runId: v.string(),
    stage: v.union(v.literal("launched"), v.literal("delivered")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.outboxId);
    const conversation = row ? await ctx.db.get(row.conversationId) : null;
    if (!row || !conversation || row.token !== args.token) return null;
    // A cancel racing the external request must still learn the accepted run.
    const canceled = row.cancelVersion !== conversation.cancelVersion || row.status === "skipped";
    await ctx.db.patch(conversation._id, {
      threadId: args.threadId,
      activeRunId: args.runId,
      instructionsPending: false,
      watchStopped: false,
      watchFailures: 0,
      watchNextAt: 0,
      lastError: undefined,
      ...(canceled ? { cancelPending: true, cancelRunId: args.runId, cancelNextAt: 0 } : {}),
    });
    const run = await ctx.db
      .query("runs")
      .withIndex("by_conversation_run", (q) =>
        q.eq("conversationId", conversation._id).eq("runId", args.runId),
      )
      .unique();
    if (!run) {
      await ctx.db.insert("runs", {
        conversationId: conversation._id,
        runId: args.runId,
        origin: "send",
        status: "running",
        ended: false,
        finalText: "",
        finalPosition: -1,
      });
      // The watcher emits the start in timeline order, before this run's items.
    }
    await ctx.db.patch(row._id, {
      status: canceled ? "skipped" : args.stage === "delivered" ? "delivered" : "pending",
      ...(args.stage === "launched"
        ? {
            initialRunId: args.runId,
            preparationStartedAt: row.preparationStartedAt ?? Date.now(),
          }
        : {}),
      ...(args.stage === "delivered" || canceled
        ? { token: undefined, leaseUntil: undefined }
        : {}),
    });
    if (canceled)
      await ctx.scheduler.runAfter(0, internal.actions.interrupt, {
        conversationId: conversation._id,
      });
    await ctx.scheduler.runAfter(0, internal.actions.watch, { conversationId: conversation._id });
    if (args.stage === "delivered") {
      const next = await ctx.db
        .query("outbox")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversationId", conversation._id).eq("status", "pending"),
        )
        .first();
      if (next) await ctx.scheduler.runAfter(0, internal.actions.deliver, { outboxId: next._id });
    }
    return null;
  },
});

export const deferDelivery = internalMutation({
  args: { ...leaseArgs, delay: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.outboxId);
    if (row?.token !== args.token || row.status !== "pending") return null;
    await ctx.db.patch(row._id, {
      token: undefined,
      leaseUntil: undefined,
      nextAttemptAt: Date.now() + args.delay,
    });
    await ctx.scheduler.runAfter(args.delay, internal.actions.deliver, { outboxId: row._id });
    return null;
  },
});
export const deliveryFailed = internalMutation({
  args: { ...leaseArgs, code: v.string(), retryable: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.outboxId);
    if (!row || row.token !== args.token) return null;
    if (row.status !== "pending") {
      await ctx.db.patch(row._id, { token: undefined, leaseUntil: undefined });
      return null;
    }
    const attempts = row.attempts + 1;
    const terminal = !args.retryable || attempts >= 5 || row.attachmentAttemptedAt !== undefined;
    const delay = Math.min(2 ** attempts * 1_000, 60_000);
    await ctx.db.patch(row._id, {
      attempts,
      lastError: args.code,
      status: terminal ? "failed" : "pending",
      token: undefined,
      leaseUntil: undefined,
      nextAttemptAt: Date.now() + delay,
    });
    const conversation = await ctx.db.get(row.conversationId);
    if (terminal && conversation) {
      await emit(ctx, conversation, `deliveryFailed:${row._id}`, {
        type: "deliveryFailed",
        conversationKey: conversation.conversationKey,
        outboxId: row._id,
        code: args.code,
      });
      const next = await ctx.db
        .query("outbox")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversationId", conversation._id).eq("status", "pending"),
        )
        .first();
      if (next) await ctx.scheduler.runAfter(0, internal.actions.deliver, { outboxId: next._id });
    } else if (!terminal)
      await ctx.scheduler.runAfter(delay, internal.actions.deliver, { outboxId: row._id });
    return null;
  },
});

export const authorizeReply = query({
  args: { replyKey: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => (await authorizedConversation(ctx, args.replyKey)).conversationKey,
});
export const recordReply = mutation({
  args: {
    replyKey: v.string(),
    text: v.string(),
    final: v.optional(v.boolean()),
    files: v.array(vStoredFile),
  },
  returns: v.object({ ok: v.boolean(), replyId: v.string() }),
  handler: async (ctx, args) => {
    const row = await authorizedConversation(ctx, args.replyKey);
    const text = args.text.trim();
    if (!text) throw new ConvexError("T3_BRIDGE_REPLY_TEXT_REQUIRED");
    if (text.length > 100_000) throw new ConvexError("T3_BRIDGE_REPLY_TEXT_TOO_LARGE");
    const turnKey = row.activeRunId ?? "idle";
    const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const digest = [...new Uint8Array(digestBytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const duplicate = await ctx.db
      .query("replies")
      .withIndex("by_turn_digest", (q) =>
        q.eq("conversationId", row._id).eq("turnKey", turnKey).eq("digest", digest),
      )
      .unique();
    if (duplicate) throw new ConvexError("T3_BRIDGE_REPLY_DUPLICATE");
    const prior = await ctx.db
      .query("replies")
      .withIndex("by_turn", (q) => q.eq("conversationId", row._id).eq("turnKey", turnKey))
      .order("desc")
      .first();
    // As in #4429, a final answer may follow an interim reply immediately.
    if (prior && !args.final && prior.createdAt > Date.now() - 90_000)
      throw new ConvexError("T3_BRIDGE_REPLY_RATE_LIMIT");
    const replyId = crypto.randomUUID();
    await ctx.db.insert("replies", {
      conversationId: row._id,
      turnKey,
      digest,
      createdAt: Date.now(),
    });
    await emit(ctx, row, `reply:${replyId}`, {
      type: "reply",
      conversationKey: row.conversationKey,
      threadId: row.threadId,
      runId: row.activeRunId,
      replyId,
      text,
      final: args.final ?? false,
      files: args.files,
    });
    if (args.final && row.activeRunId) {
      const run = await ctx.db
        .query("runs")
        .withIndex("by_conversation_run", (q) =>
          q.eq("conversationId", row._id).eq("runId", row.activeRunId ?? ""),
        )
        .unique();
      if (run) await ctx.db.patch(run._id, { finalReplyId: replyId });
    }
    return { ok: true, replyId };
  },
});

export async function byKey(ctx: Pick<QueryCtx, "db">, key: string) {
  return ctx.db
    .query("conversations")
    .withIndex("by_key", (q) => q.eq("conversationKey", key))
    .unique();
}
async function ensureConversation(
  ctx: MutationCtx,
  args: { conversationKey: string; config: string; onEvent: string },
): Promise<Doc<"conversations">> {
  if (!isConfigHandle(args.config)) throw new ConvexError("T3_BRIDGE_INVALID_CONFIG_HANDLE");
  const existing = await byKey(ctx, args.conversationKey);
  if (existing) {
    await ctx.db.patch(existing._id, { config: args.config, onEvent: args.onEvent });
    return { ...existing, config: args.config, onEvent: args.onEvent };
  }
  const id = await ctx.db.insert("conversations", {
    conversationKey: args.conversationKey,
    config: args.config,
    onEvent: args.onEvent,
    nonce: crypto.randomUUID(),
    instructionsPending: true,
    generation: 0,
    importing: false,
    position: 0,
    watchStopped: false,
    watchFailures: 0,
    watchNextAt: 0,
    cancelVersion: 0,
    cancelPending: false,
    cancelAttempt: 0,
    cancelNextAt: 0,
  });
  const row = await ctx.db.get(id);
  if (!row) throw new ConvexError("T3_BRIDGE_CONVERSATION_MISSING");
  return row;
}
async function authorizedConversation(ctx: Pick<QueryCtx, "db" | "runQuery">, key: string) {
  const conversationKey = conversationFromKey(key);
  const row = conversationKey ? await byKey(ctx, conversationKey) : null;
  if (!row || row.importing || !isConfigHandle(row.config))
    throw new ConvexError("T3_BRIDGE_UNAUTHORIZED");
  const config = await ctx.runQuery(row.config, {});
  const expected = await replyKey(row.conversationKey, row.nonce, config.replyKeySecret);
  if (!timingSafeEqual(expected, key)) throw new ConvexError("T3_BRIDGE_UNAUTHORIZED");
  return row;
}
