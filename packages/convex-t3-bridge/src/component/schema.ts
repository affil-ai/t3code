import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vAttachment, vHandles, vLaunch, vT3BridgeEvent } from "../validators.js";

export const conversationFields = {
  conversationKey: v.string(),
  ...vHandles,
  nonce: v.string(),
  threadId: v.optional(v.string()),
  projectId: v.optional(v.string()),
  launch: v.optional(vLaunch),
  instructionsPending: v.boolean(),
  position: v.number(),
  generation: v.number(),
  importing: v.boolean(),
  threadUpdatedAt: v.optional(v.string()),
  activeRunId: v.optional(v.string()),
  watcherToken: v.optional(v.string()),
  watcherLeaseUntil: v.optional(v.number()),
  watchStopped: v.boolean(),
  watchFailures: v.number(),
  watchNextAt: v.number(),
  lastError: v.optional(v.string()),
  cancelVersion: v.number(),
  cancelPending: v.boolean(),
  cancelRunId: v.optional(v.string()),
  cancelAttempt: v.number(),
  cancelNextAt: v.number(),
};
export const outboxFields = {
  conversationId: v.id("conversations"),
  clientRequestId: v.string(),
  text: v.string(),
  attachments: v.array(vAttachment),
  status: v.union(
    v.literal("pending"),
    v.literal("delivered"),
    v.literal("failed"),
    v.literal("skipped"),
  ),
  attempts: v.number(),
  nextAttemptAt: v.number(),
  token: v.optional(v.string()),
  leaseUntil: v.optional(v.number()),
  launchAttemptedAt: v.optional(v.number()),
  initialRunId: v.optional(v.string()),
  preparationStartedAt: v.optional(v.number()),
  attachmentAttemptedAt: v.optional(v.number()),
  lastError: v.optional(v.string()),
  cancelVersion: v.number(),
  launch: v.optional(vLaunch),
  includeInstructions: v.optional(v.boolean()),
};

export default defineSchema({
  conversations: defineTable(conversationFields)
    .index("by_key", ["conversationKey"])
    .index("by_thread", ["threadId"])
    .index("by_cancel", ["cancelPending", "cancelNextAt"]),
  outbox: defineTable(outboxFields)
    .index("by_conversation_status", ["conversationId", "status"])
    .index("by_conversation_lease", ["conversationId", "leaseUntil"])
    .index("by_request", ["conversationId", "clientRequestId"]),
  runs: defineTable({
    conversationId: v.id("conversations"),
    runId: v.string(),
    origin: v.union(v.literal("send"), v.literal("background")),
    status: v.string(),
    ended: v.boolean(),
    finalText: v.string(),
    finalPosition: v.number(),
    finalReplyId: v.optional(v.string()),
  })
    .index("by_conversation_run", ["conversationId", "runId"])
    .index("by_conversation_ended", ["conversationId", "ended"]),
  events: defineTable({
    conversationId: v.id("conversations"),
    eventKey: v.string(),
    event: vT3BridgeEvent,
  }).index("by_conversation_key", ["conversationId", "eventKey"]),
  replies: defineTable({
    conversationId: v.id("conversations"),
    turnKey: v.string(),
    digest: v.string(),
    createdAt: v.number(),
  })
    .index("by_turn_digest", ["conversationId", "turnKey", "digest"])
    .index("by_turn", ["conversationId", "turnKey"]),
});
