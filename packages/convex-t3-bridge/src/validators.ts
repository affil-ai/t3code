import { v, type Infer } from "convex/values";

export const vConfig = v.object({
  t3McpUrl: v.string(),
  t3McpToken: v.string(),
  replyKeySecret: v.string(),
});

export const vLaunch = v.object({
  projectId: v.string(),
  title: v.string(),
  modelSelection: v.optional(
    v.object({
      instanceId: v.string(),
      model: v.string(),
      options: v.optional(v.record(v.string(), v.union(v.string(), v.boolean()))),
    }),
  ),
  runtimeMode: v.optional(
    v.union(
      v.literal("full-access"),
      v.literal("auto"),
      v.literal("approval-required"),
      v.literal("auto-accept-edits"),
    ),
  ),
  interactionMode: v.optional(v.union(v.literal("default"), v.literal("plan"))),
  workspaceStrategy: v.optional(
    v.union(
      v.object({ type: v.literal("root"), branch: v.optional(v.string()) }),
      v.object({
        type: v.literal("worktree"),
        baseRef: v.string(),
        branch: v.optional(v.string()),
        startFromOrigin: v.optional(v.boolean()),
      }),
      v.object({
        type: v.literal("existing_worktree"),
        worktreePath: v.string(),
        branch: v.optional(v.string()),
      }),
    ),
  ),
  instructions: v.optional(v.string()),
});

export const vAttachment = v.object({
  filename: v.string(),
  mimeType: v.string(),
  url: v.string(),
  byteSize: v.number(),
  sha256: v.string(),
});
export const vStoredFile = v.object({
  filename: v.string(),
  mimeType: v.string(),
  byteSize: v.number(),
  sha256: v.string(),
  // Host storage IDs cross the component boundary as strings, not component IDs.
  storageId: v.string(),
});
export const vItem = v.object({
  position: v.number(),
  itemId: v.string(),
  runId: v.union(v.string(), v.null()),
  createdBy: v.union(v.string(), v.null()),
  creationSource: v.union(v.string(), v.null()),
  type: v.string(),
  status: v.string(),
  title: v.union(v.string(), v.null()),
  text: v.union(v.string(), v.null()),
  updatedAt: v.string(),
});
const conversation = { conversationKey: v.string() };
const thread = { ...conversation, threadId: v.string(), runId: v.string() };
export const vT3BridgeEvent = v.union(
  v.object({
    ...thread,
    type: v.literal("turnStarted"),
    origin: v.union(v.literal("send"), v.literal("background")),
  }),
  v.object({
    ...conversation,
    threadId: v.string(),
    type: v.literal("activity"),
    item: vItem,
  }),
  v.object({
    ...conversation,
    threadId: v.string(),
    type: v.literal("assistantMessage"),
    runId: v.union(v.string(), v.null()),
    itemId: v.string(),
    position: v.number(),
    text: v.string(),
  }),
  v.object({
    ...thread,
    type: v.literal("turnEnded"),
    status: v.string(),
    finalText: v.string(),
  }),
  v.object({
    ...conversation,
    type: v.literal("reply"),
    replyId: v.string(),
    threadId: v.optional(v.string()),
    runId: v.optional(v.string()),
    text: v.string(),
    final: v.boolean(),
    files: v.array(vStoredFile),
  }),
  v.object({
    ...conversation,
    type: v.literal("deliveryFailed"),
    outboxId: v.string(),
    code: v.string(),
  }),
  v.object({
    ...conversation,
    type: v.literal("watchFailed"),
    threadId: v.string(),
    code: v.string(),
  }),
);
export type T3BridgeEvent = Infer<typeof vT3BridgeEvent>;
export type Config = Infer<typeof vConfig>;
export type Launch = Infer<typeof vLaunch>;
export type Item = Infer<typeof vItem>;

export const vHandles = { config: v.string(), onEvent: v.string() };
export const vSend = {
  conversationKey: v.string(),
  text: v.string(),
  attachments: v.optional(v.array(vAttachment)),
  launch: v.optional(vLaunch),
  clientRequestId: v.optional(v.string()),
};
