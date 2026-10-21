import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { FunctionReturnType } from "convex/server";
import { v } from "convex/values";
import type { z } from "zod";
import { vT3BridgeEvent } from "../../src/validators.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";
import { slackCall, SlackError, slackMessage, slackText } from "./slackApi.js";
import { sendToAgent } from "./t3.js";
import { slackOutputFields, slackThreadFields } from "./schema.js";

const LEASE_MS = 60_000;
const STATUS_INTERVAL_MS = 3_000;
const messageValidator = v.object({
  ts: v.string(),
  text: v.optional(v.string()),
  threadTs: v.optional(v.string()),
  user: v.optional(v.string()),
});
const leaseArgs = { channel: v.string(), lease: v.number() };
const threadValidator = v.object({
  ...slackThreadFields,
  _id: v.id("slackThreads"),
  _creationTime: v.number(),
});
const outputValidator = v.object({
  ...slackOutputFields,
  _id: v.id("slackOutput"),
  _creationTime: v.number(),
});

export const acquirePoll = internalMutation({
  args: { channel: v.string() },
  returns: v.union(v.null(), v.object({ lastTs: v.string(), lease: v.number() })),
  handler: async (ctx, { channel }) => {
    const row = await ctx.db
      .query("slackPollers")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .unique();
    const now = Date.now();
    if (!row) {
      await ctx.db.insert("slackPollers", {
        channel,
        lastTs: (now / 1_000).toFixed(6),
        leaseUntil: 0,
        retryAt: 0,
      });
      return null;
    }
    if (row.leaseUntil > now || row.retryAt > now) return null;
    const lease = now + LEASE_MS;
    await ctx.db.patch(row._id, { leaseUntil: lease });
    return { lastTs: row.lastTs, lease };
  },
});

export const finishPoll = internalMutation({
  args: { ...leaseArgs, retryAfterMs: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("slackPollers")
      .withIndex("by_channel", (q) => q.eq("channel", args.channel))
      .unique();
    if (row?.leaseUntil === args.lease) {
      await ctx.db.patch(row._id, { leaseUntil: 0, retryAt: Date.now() + args.retryAfterMs });
    }
    return null;
  },
});

export const threadPage = internalQuery({
  args: { channel: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(threadValidator),
  handler: (ctx, { channel, paginationOpts }) =>
    ctx.db
      .query("slackThreads")
      .withIndex("by_channel_threadTs", (q) => q.eq("channel", channel))
      .paginate(paginationOpts),
});

// The message marker, thread mapping, cursor, and component send commit together.
// A partial API page or an expired poll can be safely fetched again.
export const ingest = internalMutation({
  args: {
    ...leaseArgs,
    threadTs: v.optional(v.string()),
    throughTs: v.string(),
    messages: v.array(messageValidator),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const poller = await ctx.db
      .query("slackPollers")
      .withIndex("by_channel", (q) => q.eq("channel", args.channel))
      .unique();
    if (!poller || poller.leaseUntil !== args.lease || args.lease <= Date.now()) return false;
    const thread = args.threadTs
      ? await ctx.db
          .query("slackThreads")
          .withIndex("by_channel_threadTs", (q) =>
            q.eq("channel", args.channel).eq("threadTs", args.threadTs ?? ""),
          )
          .unique()
      : null;
    if (args.threadTs && !thread) return false;
    const oldest = thread?.lastTs ?? poller.lastTs;
    const prefix = process.env.SLACK_TRIGGER_PREFIX ?? "t3bridge:";
    if (!prefix) throw new Error("SLACK_TRIGGER_PREFIX must not be empty");
    // Triggers launch full-access agents on the T3 host, so only listed Slack
    // users (e.g. the bot itself and the developer) may start or continue one.
    const allowed = new Set(
      (process.env.SLACK_ALLOWED_USER_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    );
    const messages = [...args.messages].sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const message of messages) {
      if (Number(message.ts) <= Number(oldest) || Number(message.ts) > Number(args.throughTs))
        continue;
      if (
        args.threadTs
          ? message.threadTs !== args.threadTs
          : message.threadTs && message.threadTs !== message.ts
      )
        continue;
      if (!message.text?.startsWith(prefix)) continue;
      if (!message.user || !allowed.has(message.user)) continue;
      const text = message.text.slice(prefix.length).trim();
      if (!text) continue;
      const duplicate = await ctx.db
        .query("slackMessages")
        .withIndex("by_channel_ts", (q) => q.eq("channel", args.channel).eq("ts", message.ts))
        .unique();
      if (duplicate) continue;
      const threadTs = args.threadTs ?? message.ts;
      const conversationKey = `slack:${args.channel}:${threadTs}`;
      if (!args.threadTs) {
        await ctx.db.insert("slackThreads", {
          channel: args.channel,
          threadTs,
          conversationKey,
          lastTs: threadTs,
          nextStatusAt: 0,
          outputLeaseUntil: 0,
        });
      }
      await ctx.db.insert("slackMessages", {
        channel: args.channel,
        ts: message.ts,
        conversationKey,
        started: false,
      });
      await sendToAgent(
        ctx,
        {
          conversationKey,
          text,
          clientRequestId: `slack:${args.channel}:${message.ts}`,
        },
        true,
      );
    }
    if (thread) await ctx.db.patch(thread._id, { lastTs: args.throughTs });
    else await ctx.db.patch(poller._id, { lastTs: args.throughTs });
    return true;
  },
});

type SlackMessage = z.infer<typeof slackMessage>;

async function readMessages(
  token: string,
  channel: string,
  oldest: string,
  latest: string,
  threadTs?: string,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor = "";
  do {
    const page = await slackCall(
      token,
      threadTs ? "conversations.replies" : "conversations.history",
      {
        channel,
        oldest,
        latest,
        limit: 100,
        ...(threadTs ? { ts: threadTs } : {}),
        ...(cursor ? { cursor } : {}),
      },
    );
    messages.push(...(page.messages ?? []));
    const next = page.response_metadata?.next_cursor ?? "";
    if (page.has_more && (!next || next === cursor)) throw new SlackError("pagination_stalled");
    cursor = next;
    if (messages.length > 1_000) throw new SlackError("poll_page_limit");
  } while (cursor);
  return messages;
}

export const poll = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_TEST_CHANNEL_ID;
    if (!token || !channel) return null;
    const claimed = await ctx.runMutation(internal.slack.acquirePoll, { channel });
    if (!claimed) return null;
    const lease = { channel, lease: claimed.lease };
    const throughTs = (Date.now() / 1_000).toFixed(6);
    let retryAfterMs = 0;
    try {
      const apply = async (oldest: string, threadTs?: string) => {
        const messages = await readMessages(token, channel, oldest, throughTs, threadTs);
        return ctx.runMutation(internal.slack.ingest, {
          ...lease,
          throughTs,
          threadTs,
          messages: messages.map((message) => ({
            ts: message.ts,
            text: message.text,
            threadTs: message.thread_ts,
            user: message.user,
          })),
        });
      };
      if (!(await apply(claimed.lastTs))) return null;
      let cursor: string | null = null;
      do {
        const page: FunctionReturnType<typeof internal.slack.threadPage> = await ctx.runQuery(
          internal.slack.threadPage,
          {
            channel,
            paginationOpts: { numItems: 50, cursor },
          },
        );
        for (const thread of page.page) {
          if (!(await apply(thread.lastTs, thread.threadTs))) return null;
        }
        cursor = page.isDone ? null : page.continueCursor;
      } while (cursor);
    } catch (error) {
      retryAfterMs = error instanceof SlackError ? error.retryAfterMs : 0;
      if (!retryAfterMs)
        console.warn(
          "Slack poll failed:",
          error instanceof SlackError ? error.code : "request_failed",
        );
    } finally {
      await ctx.runMutation(internal.slack.finishPoll, { ...lease, retryAfterMs });
    }
    return null;
  },
});

async function enqueue(
  ctx: MutationCtx,
  threadId: Id<"slackThreads">,
  kind: Doc<"slackOutput">["kind"],
  text = "",
  triggerTs?: string,
) {
  await ctx.db.insert("slackOutput", { threadId, kind, text, triggerTs, retryAt: 0 });
  await ctx.scheduler.runAfter(0, internal.slack.drain, { threadId });
}

export const onEvent = internalMutation({
  args: { event: vT3BridgeEvent },
  returns: v.null(),
  handler: async (ctx, { event }): Promise<null> => {
    const thread = await ctx.db
      .query("slackThreads")
      .withIndex("by_conversationKey", (q) => q.eq("conversationKey", event.conversationKey))
      .unique();
    if (!thread) return null;
    if (event.type === "reply") {
      await enqueue(ctx, thread._id, "reply", slackText(event.text, event.conversationKey));
    } else if (event.type === "turnStarted") {
      await ctx.db.patch(thread._id, {
        activeRunId: event.runId,
        origin: event.origin,
        nextStatusAt: 0,
      });
      if (event.origin === "send") {
        const trigger = await ctx.db
          .query("slackMessages")
          .withIndex("by_conversationKey_started", (q) =>
            q.eq("conversationKey", event.conversationKey).eq("started", false),
          )
          .first();
        if (trigger) {
          await ctx.db.patch(trigger._id, { started: true });
          await enqueue(ctx, thread._id, "reaction", "", trigger.ts);
        }
      }
    } else if (thread.origin === "send") {
      if (
        event.type === "activity" &&
        event.item.runId === thread.activeRunId &&
        thread.nextStatusAt <= Date.now()
      ) {
        await ctx.db.patch(thread._id, { nextStatusAt: Date.now() + STATUS_INTERVAL_MS });
        await enqueue(
          ctx,
          thread._id,
          "status",
          slackText(
            `Working: ${event.item.title ?? "agent is running"}`,
            event.conversationKey,
          ).slice(0, 500),
        );
      } else if (event.type === "turnEnded" && event.runId === thread.activeRunId) {
        await enqueue(ctx, thread._id, "final", slackText(event.finalText, event.conversationKey));
        await enqueue(ctx, thread._id, "done", "Done");
        await ctx.db.patch(thread._id, { activeRunId: undefined, origin: undefined });
      }
    }
    return null;
  },
});

export const claimOutput = internalMutation({
  args: { threadId: v.id("slackThreads") },
  returns: v.union(
    v.null(),
    v.object({
      thread: threadValidator,
      job: outputValidator,
      lease: v.number(),
    }),
  ),
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread || thread.outputLeaseUntil > Date.now()) return null;
    const job = await ctx.db
      .query("slackOutput")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .first();
    if (!job) return null;
    const dueAt = Math.max(
      job.retryAt,
      job.kind === "status" || job.kind === "done"
        ? (thread.lastStatusAt ?? 0) + STATUS_INTERVAL_MS
        : 0,
    );
    if (dueAt > Date.now()) {
      await ctx.scheduler.runAfter(dueAt - Date.now(), internal.slack.drain, { threadId });
      return null;
    }
    const lease = Date.now() + LEASE_MS;
    await ctx.db.patch(threadId, { outputLeaseUntil: lease });
    return { thread, job, lease };
  },
});

export const finishOutput = internalMutation({
  args: {
    threadId: v.id("slackThreads"),
    jobId: v.id("slackOutput"),
    lease: v.number(),
    retryAfterMs: v.number(),
    statusTs: v.optional(v.string()),
    updatedStatus: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread || thread.outputLeaseUntil !== args.lease) return null;
    await ctx.db.patch(thread._id, {
      outputLeaseUntil: 0,
      ...(args.statusTs ? { statusTs: args.statusTs } : {}),
      ...(args.updatedStatus ? { lastStatusAt: Date.now() } : {}),
    });
    if (args.retryAfterMs)
      await ctx.db.patch(args.jobId, { retryAt: Date.now() + args.retryAfterMs });
    else await ctx.db.delete(args.jobId);
    await ctx.scheduler.runAfter(args.retryAfterMs, internal.slack.drain, {
      threadId: args.threadId,
    });
    return null;
  },
});

export const drain = internalAction({
  args: { threadId: v.id("slackThreads") },
  returns: v.null(),
  handler: async (ctx, { threadId }): Promise<null> => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return null;
    const work = await ctx.runMutation(internal.slack.claimOutput, { threadId });
    if (!work) return null;
    const { thread, job, lease } = work;
    // Changing the configured channel must not send old queued output elsewhere.
    if (thread.channel !== process.env.SLACK_TEST_CHANNEL_ID) {
      await ctx.runMutation(internal.slack.finishOutput, {
        threadId,
        jobId: job._id,
        lease,
        retryAfterMs: 0,
        updatedStatus: false,
      });
      return null;
    }
    let retryAfterMs = 0;
    let statusTs: string | undefined;
    try {
      const base = { channel: thread.channel, thread_ts: thread.threadTs };
      if (job.kind === "reaction" && job.triggerTs) {
        await slackCall(token, "reactions.add", {
          channel: thread.channel,
          timestamp: job.triggerTs,
          name: "eyes",
        });
      } else if (job.kind === "status") {
        const result = await slackCall(
          token,
          thread.statusTs ? "chat.update" : "chat.postMessage",
          {
            ...base,
            ...(thread.statusTs ? { ts: thread.statusTs } : {}),
            text: job.text || "Working",
            unfurl_links: false,
            unfurl_media: false,
          },
        );
        statusTs = result.ts;
      } else if (job.kind === "done" && thread.statusTs) {
        await slackCall(token, "chat.update", {
          channel: thread.channel,
          ts: thread.statusTs,
          text: "Done",
        });
      } else if ((job.kind === "final" || job.kind === "reply") && job.text) {
        await slackCall(token, "chat.postMessage", {
          ...base,
          text: job.text,
          unfurl_links: false,
          unfurl_media: false,
        });
      }
    } catch (error) {
      retryAfterMs = error instanceof SlackError ? error.retryAfterMs : 0;
      if (!retryAfterMs && !(error instanceof SlackError && error.code === "already_reacted")) {
        console.warn(
          "Slack output failed:",
          error instanceof SlackError ? error.code : "request_failed",
        );
      }
    }
    await ctx.runMutation(internal.slack.finishOutput, {
      threadId,
      jobId: job._id,
      lease,
      retryAfterMs,
      statusTs,
      updatedStatus: (job.kind === "status" || job.kind === "done") && !retryAfterMs,
    });
    return null;
  },
});
