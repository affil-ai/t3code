import { ConvexError, v } from "convex/values";
import { T3Bridge } from "../../src/client/index.js";
import { vConfig, vT3BridgeEvent } from "../../src/validators.js";
import { components, internal } from "./_generated/api.js";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server.js";
import { eventFields } from "./schema.js";

export const t3 = new T3Bridge(components.t3Bridge, {
  config: internal.t3.config,
  onEvent: internal.t3.onEvent,
});

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new ConvexError(`Missing environment variable: ${name}`);
  return value;
}

export const config = internalQuery({
  args: {},
  returns: vConfig,
  handler: () => ({
    t3McpUrl: requiredEnv("T3_MCP_URL"),
    t3McpToken: requiredEnv("T3_MCP_TOKEN"),
    replyKeySecret: requiredEnv("T3_BRIDGE_REPLY_SECRET"),
  }),
});

export const onEvent = internalMutation({
  args: { event: vT3BridgeEvent },
  returns: v.null(),
  handler: async (ctx, { event }) => {
    await ctx.db.insert("events", {
      conversationKey: event.conversationKey,
      type: event.type,
      payload: event,
      createdAt: Date.now(),
    });
    return null;
  },
});

// These unauthenticated functions are for an isolated local test app only.
export const sendMessage = mutation({
  args: { conversationKey: v.string(), text: v.string() },
  returns: v.string(),
  handler: async (ctx, { conversationKey, text }): Promise<string> => {
    // Fail before scheduling anything when phase-2 secrets are still missing.
    requiredEnv("T3_MCP_TOKEN");
    requiredEnv("T3_BRIDGE_REPLY_SECRET");
    return t3.send(ctx, {
      conversationKey,
      text,
      launch: {
        projectId: requiredEnv("T3_TEST_PROJECT_ID"),
        title: `Convex bridge test ${conversationKey}`,
        modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-5-5" },
        runtimeMode: "full-access",
        workspaceStrategy: { type: "root" },
        instructions:
          "Answer the request in your final message. Do not edit, create, or delete files. " +
          "Do not use the reply tool for these tests.",
      },
    });
  },
});

export const cancel = mutation({
  args: { conversationKey: v.string() },
  returns: v.null(),
  handler: (ctx, args): Promise<null> => t3.cancel(ctx, args),
});

export const listEvents = query({
  args: { conversationKey: v.string() },
  returns: v.array(v.object({ ...eventFields, _id: v.id("events"), _creationTime: v.number() })),
  handler: async (ctx, { conversationKey }) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_conversationKey", (q) => q.eq("conversationKey", conversationKey))
      .take(1001);
    if (events.length > 1000) throw new ConvexError("EXAMPLE_EVENT_LIMIT_EXCEEDED");
    return events;
  },
});

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
  handler: (ctx, args) => t3.getConversation(ctx, args),
});
