import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { conversationFields } from "./schema.js";
import { vItem, type Item } from "../validators.js";
import { isActive } from "./t3Mcp.js";
import { emit } from "./events.js";
import { isEventHandle } from "./handles.js";

const conversationDoc = v.object({
  ...conversationFields,
  _id: v.id("conversations"),
  _creationTime: v.number(),
});
const watchLease = {
  conversationId: v.id("conversations"),
  threadId: v.string(),
  token: v.string(),
  generation: v.number(),
};

export const acquire = internalMutation({
  args: { conversationId: v.id("conversations") },
  returns: v.union(v.null(), v.object({ conversation: conversationDoc, token: v.string() })),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.conversationId);
    if (
      !row?.threadId ||
      row.importing ||
      row.watchStopped ||
      row.watchNextAt > Date.now() ||
      (row.watcherLeaseUntil ?? 0) > Date.now()
    )
      return null;
    const token = crypto.randomUUID();
    await ctx.db.patch(row._id, { watcherToken: token, watcherLeaseUntil: Date.now() + 60_000 });
    return { conversation: row, token };
  },
});

export const renew = internalMutation({
  args: watchLease,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.conversationId);
    if (!matchesLease(row, args)) return false;
    await ctx.db.patch(row._id, { watcherLeaseUntil: Date.now() + 60_000 });
    return true;
  },
});

export const applyBatch = internalMutation({
  args: {
    ...watchLease,
    position: v.number(),
    threadStatus: v.string(),
    activeRunId: v.optional(v.string()),
    latestRunId: v.optional(v.string()),
    threadUpdatedAt: v.optional(v.string()),
    runs: v.array(v.object({ runId: v.string(), status: v.string() })),
    items: v.array(vItem),
    hasMore: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.conversationId);
    if (!matchesLease(row, args)) return false;
    const sending = await ctx.db
      .query("outbox")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversationId", row._id).eq("status", "pending"),
      )
      .first();
    // Acceptance commits the send-origin run before the watcher may discover it.
    if (sending?.token && !sending.initialRunId && (sending.leaseUntil ?? 0) > Date.now()) {
      await ctx.db.patch(row._id, { watcherToken: undefined, watcherLeaseUntil: undefined });
      await ctx.scheduler.runAfter(2_000, internal.actions.watch, { conversationId: row._id });
      return false;
    }
    const open = await ctx.db
      .query("runs")
      .withIndex("by_conversation_ended", (q) => q.eq("conversationId", row._id).eq("ended", false))
      .take(100);
    const groups = new Map<string | null, Item[]>();
    for (const item of args.items) {
      if (item.position <= row.position) continue;
      const group = groups.get(item.runId) ?? [];
      group.push(item);
      groups.set(item.runId, group);
    }
    const statusOf = (runId: string) =>
      args.runs.find((run) => run.runId === runId)?.status ??
      (runId === (args.activeRunId ?? args.latestRunId) ? args.threadStatus : undefined);
    for (const run of open) {
      if (groups.has(run.runId)) continue;
      await ensureRun(ctx, row, run.runId);
      if (!args.hasMore) await finishRun(ctx, row, run.runId, statusOf(run.runId));
    }
    let remaining = groups.size;
    for (const [runId, items] of groups) {
      if (runId) await ensureRun(ctx, row, runId);
      for (const item of items) await writeItem(ctx, row, item);
      remaining--;
      // All but the last run on a page are complete in the timeline. The last
      // run may have more final-text items on the next page.
      if (runId && (!args.hasMore || remaining > 0)) {
        await finishRun(ctx, row, runId, statusOf(runId));
      }
    }
    const current = args.activeRunId ?? args.latestRunId;
    if (!args.hasMore && current && !groups.has(current)) {
      await ensureRun(ctx, row, current);
      await finishRun(ctx, row, current, statusOf(current));
    }
    await ctx.db.patch(row._id, {
      position: Math.max(row.position, args.position),
      activeRunId: args.activeRunId ?? args.latestRunId ?? row.activeRunId,
      watcherToken: undefined,
      watcherLeaseUntil: undefined,
      watchFailures: 0,
      watchNextAt: 0,
      lastError: undefined,
      threadUpdatedAt: args.threadUpdatedAt,
    });
    if (args.hasMore || isActive(args.threadStatus)) {
      await ctx.scheduler.runAfter(args.hasMore ? 0 : 2_000, internal.actions.watch, {
        conversationId: row._id,
      });
    }
    return true;
  },
});

export const failure = internalMutation({
  args: { ...watchLease, code: v.string(), retryable: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.conversationId);
    if (!matchesLease(row, args)) return null;
    const delay = Math.min(2 ** Math.min(row.watchFailures + 1, 6) * 1_000, 60_000);
    await ctx.db.patch(row._id, {
      watcherToken: undefined,
      watcherLeaseUntil: undefined,
      watchStopped: !args.retryable,
      watchFailures: row.watchFailures + 1,
      watchNextAt: Date.now() + delay,
      lastError: args.code,
    });
    if (!args.retryable) {
      await emit(ctx, row, `watchFailed:${row.generation}:${row.watchFailures}:${args.code}`, {
        type: "watchFailed",
        conversationKey: row.conversationKey,
        threadId: args.threadId,
        code: args.code,
      });
    } else {
      await ctx.scheduler.runAfter(delay, internal.actions.watch, { conversationId: row._id });
    }
    return null;
  },
});

export const sweepPage = internalQuery({
  args: { after: v.optional(v.string()) },
  returns: v.array(conversationDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversations")
      .withIndex("by_sweep", (q) => {
        return args.after === undefined ? q : q.gt("conversationKey", args.after);
      })
      .take(100);
  },
});
export const dueOutbox = internalQuery({
  args: { conversationIds: v.array(v.id("conversations")) },
  returns: v.array(v.id("outbox")),
  handler: async (ctx, args) => {
    const ids = [];
    for (const conversationId of args.conversationIds.slice(0, 100)) {
      const row = await ctx.db
        .query("outbox")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversationId", conversationId).eq("status", "pending"),
        )
        .first();
      if (row && row.nextAttemptAt <= Date.now() && (row.leaseUntil ?? 0) <= Date.now())
        ids.push(row._id);
    }
    return ids;
  },
});
export const claimCancel = internalMutation({
  args: { conversationId: v.id("conversations") },
  returns: v.union(v.null(), conversationDoc),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.conversationId);
    if (!row?.cancelPending || !row.threadId || row.cancelNextAt > Date.now()) return null;
    await ctx.db.patch(row._id, {
      cancelAttempt: row.cancelAttempt + 1,
      cancelNextAt: Date.now() + 8_000,
    });
    return row;
  },
});
export const cancelDone = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    cancelVersion: v.number(),
    threadId: v.string(),
    runId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.conversationId);
    if (
      !row ||
      row.cancelVersion !== args.cancelVersion ||
      row.threadId !== args.threadId ||
      row.cancelRunId !== args.runId
    )
      return null;
    await ctx.db.patch(row._id, { cancelPending: false });
    await ctx.scheduler.runAfter(0, internal.actions.watch, { conversationId: row._id });
    return null;
  },
});
export const dueCancels = internalQuery({
  args: {},
  returns: v.array(v.id("conversations")),
  handler: async (ctx) =>
    (
      await ctx.db
        .query("conversations")
        .withIndex("by_cancel", (q) => q.eq("cancelPending", true).lte("cancelNextAt", Date.now()))
        .take(100)
    ).map((row) => row._id),
});

function matchesLease(
  row: Doc<"conversations"> | null,
  args: { threadId: string; token: string; generation: number },
): row is Doc<"conversations"> {
  return (
    row !== null &&
    !row.importing &&
    row.threadId === args.threadId &&
    row.watcherToken === args.token &&
    row.generation === args.generation
  );
}
async function getRun(ctx: MutationCtx, row: Doc<"conversations">, runId: string) {
  return ctx.db
    .query("runs")
    .withIndex("by_conversation_run", (q) => q.eq("conversationId", row._id).eq("runId", runId))
    .unique();
}
async function ensureRun(ctx: MutationCtx, row: Doc<"conversations">, runId: string) {
  const existing = await getRun(ctx, row, runId);
  if (existing) {
    if (existing.status !== "imported")
      await emit(ctx, row, `turnStarted:${runId}`, {
        type: "turnStarted",
        conversationKey: row.conversationKey,
        threadId: row.threadId ?? "",
        runId,
        origin: existing.origin,
      });
    return existing;
  }
  const id = await ctx.db.insert("runs", {
    conversationId: row._id,
    runId,
    origin: "background",
    status: "running",
    ended: false,
    finalText: "",
    finalPosition: -1,
  });
  await emit(ctx, row, `turnStarted:${runId}`, {
    type: "turnStarted",
    conversationKey: row.conversationKey,
    threadId: row.threadId ?? "",
    runId,
    origin: "background",
  });
  const run = await ctx.db.get(id);
  if (!run) throw new ConvexError("T3_BRIDGE_RUN_MISSING");
  return run;
}

async function finishRun(
  ctx: MutationCtx,
  row: Doc<"conversations">,
  runId: string,
  status: string | undefined,
) {
  if (!status || isActive(status) || status === "idle") return;
  const run = await getRun(ctx, row, runId);
  if (!run || run.ended) return;
  await ctx.db.patch(run._id, { status, ended: true });
  await emit(ctx, row, `turnEnded:${runId}`, {
    type: "turnEnded",
    conversationKey: row.conversationKey,
    threadId: row.threadId ?? "",
    runId,
    status,
    finalText: run.finalText,
  });
}

async function writeItem(ctx: MutationCtx, row: Doc<"conversations">, item: Item) {
  if (item.type === "assistant_message" && item.text?.trim()) {
    await emit(ctx, row, `assistant:${item.itemId}`, {
      type: "assistantMessage",
      conversationKey: row.conversationKey,
      threadId: row.threadId ?? "",
      runId: item.runId,
      itemId: item.itemId,
      position: item.position,
      text: item.text,
    });
    if (item.runId) {
      const run = await getRun(ctx, row, item.runId);
      if (run && item.position >= run.finalPosition) {
        await ctx.db.patch(run._id, { finalText: item.text, finalPosition: item.position });
      }
    }
  } else if (["command_execution", "tool_call", "file_change", "reasoning"].includes(item.type)) {
    if (!isEventHandle(row.onEvent)) throw new ConvexError("T3_BRIDGE_INVALID_EVENT_HANDLE");
    // Callback failure cannot roll back durable messages or the cursor.
    await ctx.scheduler.runAfter(0, row.onEvent, {
      event: {
        type: "activity",
        conversationKey: row.conversationKey,
        threadId: row.threadId ?? "",
        item,
      },
    });
  }
}
