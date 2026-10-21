import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vT3BridgeEvent } from "../../src/validators.js";

export const eventFields = {
  conversationKey: v.string(),
  type: v.string(),
  payload: vT3BridgeEvent,
  createdAt: v.number(),
};

export default defineSchema({
  events: defineTable(eventFields).index("by_conversationKey", ["conversationKey"]),
});
