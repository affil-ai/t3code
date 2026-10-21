import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vT3BridgeEvent } from "../../src/validators.js";

export const eventFields = {
  conversationKey: v.string(),
  type: v.string(),
  payload: vT3BridgeEvent,
  createdAt: v.number(),
};

export const slackThreadFields = {
  channel: v.string(),
  threadTs: v.string(),
  conversationKey: v.string(),
  lastTs: v.string(),
  activeRunId: v.optional(v.string()),
  origin: v.optional(v.union(v.literal("send"), v.literal("background"))),
  statusTs: v.optional(v.string()),
  nextStatusAt: v.number(),
  lastStatusAt: v.optional(v.number()),
  outputLeaseUntil: v.number(),
};

export const slackOutputFields = {
  threadId: v.id("slackThreads"),
  kind: v.union(
    v.literal("reaction"),
    v.literal("status"),
    v.literal("final"),
    v.literal("done"),
    v.literal("reply"),
  ),
  text: v.string(),
  triggerTs: v.optional(v.string()),
  retryAt: v.number(),
};

export default defineSchema({
  events: defineTable(eventFields).index("by_conversationKey", ["conversationKey"]),
  slackPollers: defineTable({
    channel: v.string(),
    lastTs: v.string(),
    leaseUntil: v.number(),
    retryAt: v.number(),
  }).index("by_channel", ["channel"]),
  slackThreads: defineTable(slackThreadFields)
    .index("by_channel_threadTs", ["channel", "threadTs"])
    .index("by_conversationKey", ["conversationKey"]),
  slackMessages: defineTable({
    channel: v.string(),
    ts: v.string(),
    conversationKey: v.string(),
    started: v.boolean(),
  })
    .index("by_channel_ts", ["channel", "ts"])
    .index("by_conversationKey_started", ["conversationKey", "started"]),
  slackOutput: defineTable(slackOutputFields).index("by_threadId", ["threadId"]),
});
