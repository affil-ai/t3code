import { ConvexError, v } from "convex/values";
import { api, internal } from "./_generated/api.js";
import { action, internalAction, type ActionCtx } from "./_generated/server.js";
import { isConfigHandle } from "./handles.js";
import { replyKey } from "./replyKey.js";
import { vHandles } from "../validators.js";
import { T3McpClient, T3McpError, fullItems, isActive, type UploadedAttachment } from "./t3Mcp.js";
import type { FunctionReturnType } from "convex/server";
import type { Doc } from "./_generated/dataModel.js";

type Delivery = NonNullable<FunctionReturnType<typeof internal.bridge.claimDelivery>>;

export const deliver = internalAction({
  args: { outboxId: v.id("outbox") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const input = await ctx.runMutation(internal.bridge.claimDelivery, args);
    if (!input) return null;
    const lease = { outboxId: args.outboxId, token: input.token };
    try {
      const config = await readConfig(ctx, input.conversation.config);
      const client = new T3McpClient(config);
      const key = await replyKey(
        input.conversation.conversationKey,
        input.conversation.nonce,
        config.replyKeySecret,
      );
      const message = formatMessage(input, key);
      let threadId = input.conversation.threadId;
      let initialRunId = input.row.initialRunId;
      let preparationStartedAt = input.row.preparationStartedAt;
      if (!threadId) {
        if (!input.row.launch)
          throw new T3McpError(
            "T3_MCP_LAUNCH_CONFIG_MISSING",
            false,
            "A new conversation needs launch configuration.",
          );
        const marker = `t3-bridge:${input.row._id}`;
        const existing = await client.listThreads({
          projectId: input.row.launch.projectId,
          titleContains: marker,
          limit: 100,
        });
        const recovered = existing.threads.find((thread) => thread.title.endsWith(`[${marker}]`));
        if (recovered) {
          threadId = recovered.threadId;
          initialRunId = recovered.latestRunId ?? undefined;
        } else {
          if (
            !(await ctx.runMutation(internal.bridge.deliveryGuard, { ...lease, stage: "launch" }))
          )
            return null;
          const suffix = input.row.attachments.length
            ? `\n\n${input.row.attachments.length} attached file(s) follow after workspace preparation.`
            : "";
          const launched = await client.launchThread(
            input.row.launch,
            `${input.row.launch.title.slice(0, 140)} [${marker}]`,
            message + suffix,
          );
          threadId = launched.threadId;
          initialRunId = launched.runId ?? undefined;
        }
        if (!initialRunId)
          throw new T3McpError(
            "T3_MCP_LAUNCH_RUN_MISSING",
            false,
            "T3 accepted a message without a run.",
          );
        preparationStartedAt ??= input.row.launchAttemptedAt ?? Date.now();
        await ctx.runMutation(internal.bridge.acceptDelivery, {
          ...lease,
          threadId,
          runId: initialRunId,
          stage: input.row.attachments.length ? "launched" : "delivered",
        });
        if (!input.row.attachments.length) return null;
      }
      if (initialRunId) {
        if (Date.now() - (preparationStartedAt ?? Date.now()) >= 30 * 60_000) {
          throw new T3McpError(
            "T3_MCP_WORKSPACE_PREPARATION_TIMEOUT",
            false,
            "Workspace preparation timed out.",
          );
        }
        const ready = await firstRunStarted(client, threadId, initialRunId);
        if (!ready) {
          await ctx.runMutation(internal.bridge.deferDelivery, { ...lease, delay: 2_000 });
          return null;
        }
      }
      if (input.row.attachments.length) {
        if (input.row.attachmentAttemptedAt !== undefined) {
          throw new T3McpError(
            "T3_MCP_ATTACHMENT_DELIVERY_UNCERTAIN",
            false,
            "An attachment send cannot be retried.",
          );
        }
        const attachments = await uploadAttachments(ctx, input, client);
        if (
          !(await ctx.runMutation(internal.bridge.deliveryGuard, {
            ...lease,
            stage: "attachments",
          }))
        )
          return null;
        const sent = await client.sendAttachments(
          threadId,
          initialRunId
            ? `<!-- t3_reply_key: ${key} -->\n\nAttached files for the request above.`
            : message,
          attachments,
        );
        await ctx.runMutation(internal.bridge.acceptDelivery, {
          ...lease,
          threadId,
          runId: sent.runId,
          stage: "delivered",
        });
      } else {
        if (!(await ctx.runMutation(internal.bridge.deliveryGuard, { ...lease, stage: "renew" })))
          return null;
        const sent = await client.sendThread(threadId, message, `t3-bridge:${input.row._id}`);
        await ctx.runMutation(internal.bridge.acceptDelivery, {
          ...lease,
          threadId,
          runId: sent.runId,
          stage: "delivered",
        });
      }
    } catch (error) {
      await ctx.runMutation(internal.bridge.deliveryFailed, {
        ...lease,
        code: error instanceof T3McpError ? error.code : "T3_MCP_DELIVERY_FAILED",
        retryable: !(error instanceof T3McpError) || error.retryable,
      });
    }
    return null;
  },
});

export const watch = internalAction({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const claimed = await ctx.runMutation(internal.watcher.acquire, args);
    const threadId = claimed?.conversation.threadId;
    if (!claimed || !threadId) return null;
    const lease = {
      conversationId: args.conversationId,
      threadId,
      generation: claimed.conversation.generation,
      token: claimed.token,
    };
    try {
      const client = new T3McpClient(await readConfig(ctx, claimed.conversation.config));
      const page = await client.readThread({
        threadId,
        afterPosition: claimed.conversation.position,
        limit: 100,
        runLimit: 100,
        maxCharsPerItem: 2_000,
      });
      // Renew between text continuation requests so a slow read keeps one reader.
      const items = await fullItems(client, threadId, page.items, async () => {
        if (!(await ctx.runMutation(internal.watcher.renew, lease)))
          throw new Error("T3_BRIDGE_STALE_LEASE");
      });
      const position = page.nextPosition ?? items.at(-1)?.position ?? claimed.conversation.position;
      if (page.hasMore && position <= claimed.conversation.position) {
        throw new T3McpError(
          "T3_MCP_PAGINATION_STALLED",
          false,
          "Thread pagination did not advance.",
        );
      }
      await ctx.runMutation(internal.watcher.applyBatch, {
        ...lease,
        position,
        threadStatus: page.thread.status,
        hasMore: page.hasMore,
        activeRunId: page.thread.activeRunId ?? undefined,
        latestRunId: page.thread.latestRunId ?? undefined,
        threadUpdatedAt: page.thread.updatedAt,
        runs: page.recentRuns.map((run) => ({ runId: run.runId, status: run.status })),
        items: items.map(({ textTruncated: _truncated, nextTextOffset: _offset, ...item }) => item),
      });
    } catch (error) {
      await ctx.runMutation(internal.watcher.failure, {
        ...lease,
        code: error instanceof T3McpError ? error.code : "T3_MCP_WATCH_FAILED",
        retryable: !(error instanceof T3McpError) || error.retryable,
      });
    }
    return null;
  },
});

export const importThread = action({
  args: { conversationKey: v.string(), threadId: v.string(), ...vHandles },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.runMutation(api.bridge.beginImport, args);
    try {
      const client = new T3McpClient(await readConfig(ctx, row.config));
      let position = 0;
      let latestRunId: string | undefined;
      let projectId = "";
      const runIds = new Set<string>();
      let hasMore: boolean;
      do {
        const page = await client.readThread({
          threadId: args.threadId,
          afterPosition: position,
          limit: 100,
          runLimit: 100,
        });
        const next = page.nextPosition ?? page.items.at(-1)?.position ?? position;
        if (page.hasMore && next <= position)
          throw new T3McpError(
            "T3_MCP_PAGINATION_STALLED",
            false,
            "Import pagination did not advance.",
          );
        position = next;
        hasMore = page.hasMore;
        projectId = page.thread.projectId;
        latestRunId = page.thread.latestRunId ?? undefined;
        for (const run of page.recentRuns) runIds.add(run.runId);
        for (const item of page.items) if (item.runId) runIds.add(item.runId);
      } while (hasMore);
      await ctx.runMutation(internal.bridge.finishImport, {
        conversationId: row._id,
        generation: row.generation,
        threadId: args.threadId,
        position,
        projectId,
        runIds: [...runIds],
        latestRunId,
      });
    } catch (error) {
      await ctx.runMutation(internal.bridge.abortImport, {
        conversationId: row._id,
        generation: row.generation,
      });
      throw error;
    }
    return null;
  },
});

/** Component cron entrypoint. Discovery is grouped by host config and project. */
export const sweep = action({
  args: { after: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const groups = new Map<string, Doc<"conversations">[]>();
    const conversations = await ctx.runQuery(internal.watcher.sweepPage, args);
    for (const row of conversations) {
      if (!row.threadId || row.watchStopped || row.importing) continue;
      const key = JSON.stringify([row.config, row.projectId]);
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    if (conversations.length === 100) {
      await ctx.scheduler.runAfter(0, api.actions.sweep, {
        after: conversations.at(-1)?.conversationKey,
      });
    }
    for (const rows of groups.values()) {
      const first = rows[0];
      if (!first) continue;
      try {
        const client = new T3McpClient(await readConfig(ctx, first.config));
        const changed = new Map<
          string,
          { updatedAt: string; latestRunId: string | null; status: string }
        >();
        let cursor: number | undefined;
        do {
          const page = await client.listThreads({
            projectId: first.projectId,
            cursor,
            limit: 100,
            includeSubagents: true,
          });
          for (const thread of page.threads) {
            // Completed background runs must be discovered too, even between sweeps.
            changed.set(thread.threadId, thread);
          }
          if (page.nextCursor != null && page.nextCursor === cursor)
            throw new Error("T3_MCP_LIST_PAGINATION_STALLED");
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        for (const row of rows) {
          const remote = row.threadId ? changed.get(row.threadId) : undefined;
          if (
            row.threadId &&
            (row.lastError ||
              (remote &&
                (isActive(remote.status) ||
                  remote.latestRunId !== row.activeRunId ||
                  remote.updatedAt !== row.threadUpdatedAt))) &&
            row.watchNextAt <= Date.now() &&
            (row.watcherLeaseUntil ?? 0) <= Date.now()
          ) {
            await ctx.scheduler.runAfter(0, internal.actions.watch, { conversationId: row._id });
          }
        }
      } catch {
        // Per-conversation watchers report failures. One bad config must not
        // prevent delivery/cancel recovery for other installed host apps.
        for (const row of rows) {
          if (row.watchNextAt <= Date.now())
            await ctx.scheduler.runAfter(0, internal.actions.watch, { conversationId: row._id });
        }
      }
    }
    const due = await ctx.runQuery(internal.watcher.dueOutbox, {
      conversationIds: conversations.map((row) => row._id),
    });
    for (const outboxId of due)
      await ctx.scheduler.runAfter(0, internal.actions.deliver, { outboxId });
    const cancels = await ctx.runQuery(internal.watcher.dueCancels, {});
    for (const conversationId of cancels)
      await ctx.scheduler.runAfter(0, internal.actions.interrupt, { conversationId });
    return null;
  },
});

export const interrupt = internalAction({
  args: { conversationId: v.id("conversations") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.runMutation(internal.watcher.claimCancel, args);
    if (!row?.threadId) return null;
    const runId = row.cancelRunId;
    try {
      const client = new T3McpClient(await readConfig(ctx, row.config));
      await client.interruptThread(
        row.threadId,
        runId,
        `t3-bridge-cancel:${row._id}:${row.cancelVersion}:${runId ?? "active"}`,
      );
      await ctx.runMutation(internal.watcher.cancelDone, {
        ...args,
        cancelVersion: row.cancelVersion,
        threadId: row.threadId,
        runId,
      });
    } catch {
      await ctx.scheduler.runAfter(8_000, internal.actions.interrupt, args);
    }
    return null;
  },
});

async function readConfig(ctx: Pick<ActionCtx, "runQuery">, handle: string) {
  if (!isConfigHandle(handle)) throw new ConvexError("T3_BRIDGE_INVALID_CONFIG_HANDLE");
  return ctx.runQuery(handle, {});
}
function formatMessage(input: Delivery, key: string) {
  return [
    `<!-- t3_reply_key: ${key} -->`,
    input.row.includeInstructions ? input.row.launch?.instructions : undefined,
    input.row.text,
  ]
    .filter(Boolean)
    .join("\n\n");
}
async function firstRunStarted(client: T3McpClient, threadId: string, runId: string) {
  const page = await client.readThread({ threadId, limit: 1, runLimit: 100 });
  const run = page.recentRuns.find((item) => item.runId === runId);
  if (!run) return false;
  if (["failed", "interrupted", "cancelled", "rolled_back"].includes(run.status)) {
    throw new T3McpError(
      "T3_MCP_WORKSPACE_PREPARATION_FAILED",
      false,
      "Initial run failed before attachment delivery.",
    );
  }
  return run.startedAt !== null || run.status === "completed";
}
async function uploadAttachments(ctx: ActionCtx, input: Delivery, client: T3McpClient) {
  const uploaded: UploadedAttachment[] = [];
  const lease = { outboxId: input.row._id, token: input.token, stage: "renew" };
  for (const file of input.row.attachments) {
    if (!(await ctx.runMutation(internal.bridge.deliveryGuard, { ...lease, stage: "renew" })))
      throw new Error("T3_BRIDGE_CANCELED");
    const response = await fetch(file.url, {
      signal: AbortSignal.timeout(25_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new T3McpError(
        "T3_ATTACHMENT_FETCH_FAILED",
        response.status >= 500,
        "Attachment fetch failed.",
      );
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== file.byteSize)
      throw new T3McpError("T3_ATTACHMENT_SIZE_MISMATCH", false, "Attachment size changed.");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (sha256 !== file.sha256.toLowerCase())
      throw new T3McpError("T3_ATTACHMENT_DIGEST_MISMATCH", false, "Attachment digest changed.");
    const type = file.mimeType.startsWith("image/") ? "image" : "file";
    const result = await client.prepareUpload({
      type,
      name: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.byteSize,
    });
    if (!(await ctx.runMutation(internal.bridge.deliveryGuard, { ...lease, stage: "renew" })))
      throw new Error("T3_BRIDGE_CANCELED");
    await client.upload(result.relativeUrl, bytes, file.mimeType);
    uploaded.push({
      type,
      id: result.attachmentId,
      name: file.filename,
      mimeType: file.mimeType,
      sizeBytes: file.byteSize,
    });
  }
  return uploaded;
}
