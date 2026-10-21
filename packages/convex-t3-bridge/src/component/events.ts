import { ConvexError } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import type { T3BridgeEvent } from "../validators.js";
import { isEventHandle } from "./handles.js";

/** The host mutation and event record commit with the caller's cursor update. */
export async function emit(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  eventKey: string,
  event: T3BridgeEvent,
) {
  const existing = await ctx.db
    .query("events")
    .withIndex("by_conversation_key", (q) =>
      q.eq("conversationId", conversation._id).eq("eventKey", eventKey),
    )
    .unique();
  if (existing) return;
  if (!isEventHandle(conversation.onEvent)) throw new ConvexError("T3_BRIDGE_INVALID_EVENT_HANDLE");
  await ctx.db.insert("events", { conversationId: conversation._id, eventKey, event });
  await ctx.runMutation(conversation.onEvent, { event });
}
