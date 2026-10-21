import { z } from "zod";
import type { Config, Launch } from "../validators.js";

const runStatus = z.enum([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const threadStatus = z.union([z.literal("idle"), runStatus]);
const threadItem = z.object({
  position: z.number(),
  itemId: z.string(),
  runId: z.string().nullable(),
  createdBy: z.string().nullable(),
  creationSource: z.string().nullable(),
  type: z.string(),
  status: z.string(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  updatedAt: z.string(),
  textTruncated: z.boolean(),
  nextTextOffset: z.number().nullable().optional(),
});
const readResult = z.object({
  thread: z.object({
    threadId: z.string(),
    projectId: z.string(),
    status: threadStatus,
    activeRunId: z.string().nullable(),
    latestRunId: z.string().nullable(),
    updatedAt: z.string().optional(),
  }),
  recentRuns: z.array(
    z.object({
      runId: z.string(),
      ordinal: z.number(),
      status: runStatus,
      startedAt: z.string().nullable(),
    }),
  ),
  items: z.array(threadItem),
  nextPosition: z.number().nullable(),
  hasMore: z.boolean(),
});
const listResult = z.object({
  threads: z.array(
    z.object({
      threadId: z.string(),
      title: z.string(),
      status: threadStatus,
      latestRunId: z.string().nullable(),
      updatedAt: z.string(),
    }),
  ),
  nextCursor: z.number().nullable(),
});
const launchResult = z.object({
  threadId: z.string(),
  projectId: z.string(),
  runId: z.string().nullable(),
  status: runStatus.nullable(),
});
const sendResult = z.object({ threadId: z.string(), runId: z.string(), status: runStatus });
const uploadResult = z.object({
  attachmentId: z.string(),
  relativeUrl: z.string(),
  expiresAt: z.number(),
});
const uploadedAttachment = z.object({
  type: z.enum(["image", "file"]),
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
});
const toolResult = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z
    .array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
    .optional(),
});
const responseSchema = z.object({
  result: toolResult.optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).optional(),
});

export type ThreadPage = z.infer<typeof readResult>;
export type ThreadItem = z.infer<typeof threadItem>;
export type UploadedAttachment = z.infer<typeof uploadedAttachment>;

export class T3McpError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "T3McpError";
  }
}

const permanentFailures = new Set([
  "capability_denied",
  "parent_not_active",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
  "task_not_found",
  "task_not_cancellable",
  "thread_not_found",
  "run_not_found",
  "thread_not_sendable",
  "thread_not_interruptible",
  "invalid_request",
  "thread_credential_required",
  "target_required",
]);

/** The configured URL is the MCP endpoint, including its path, not an origin. */
export class T3McpClient {
  private sessionId: string | undefined;
  private initialized = false;
  private requestId = 0;
  constructor(
    private readonly config: Config,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async readThread(input: {
    threadId: string;
    itemId?: string;
    textOffset?: number;
    afterPosition?: number;
    limit?: number;
    runLimit?: number;
    maxCharsPerItem?: number;
    view?: "activity" | "messages";
  }) {
    const page = await this.call(
      "t3_thread_read",
      { ...input, view: input.view ?? "activity" },
      readResult,
    );
    if (page.thread.threadId !== input.threadId) {
      throw new T3McpError("T3_MCP_THREAD_MISMATCH", false, "T3 returned a different thread.");
    }
    return page;
  }
  listThreads(input: {
    projectId?: string;
    titleContains?: string;
    cursor?: number;
    limit?: number;
    includeSubagents?: boolean;
  }) {
    return this.call("t3_thread_list", input, listResult);
  }
  launchThread(launch: Launch, title: string, message: string) {
    const { instructions: _instructions, ...options } = launch;
    return this.call("t3_thread_launch", { ...options, title, message }, launchResult);
  }
  sendThread(threadId: string, message: string, clientRequestId: string) {
    return this.call(
      "t3_thread_send",
      { threadId, message, clientRequestId, mode: "auto" },
      sendResult,
    );
  }
  interruptThread(threadId: string, runId: string | undefined, clientRequestId: string) {
    return this.call(
      "t3_thread_interrupt",
      {
        threadId,
        ...(runId ? { runId } : {}),
        clientRequestId,
        reason: "The conversation requested cancellation.",
      },
      z.object({ threadId: z.string(), runId: z.string().nullable(), status: z.string() }),
    );
  }
  prepareUpload(upload: {
    type: "image" | "file";
    name: string;
    mimeType: string;
    sizeBytes: number;
  }) {
    return this.call("t3_attachment_prepare_upload", { upload }, uploadResult);
  }
  sendAttachments(threadId: string, message: string, attachments: UploadedAttachment[]) {
    return this.call("t3_thread_send_attachments", { threadId, message, attachments }, sendResult);
  }
  async upload(relativeUrl: string, bytes: ArrayBuffer, mimeType: string) {
    const origin = new URL(this.config.t3McpUrl);
    const url = new URL(relativeUrl, origin);
    if (url.origin !== origin.origin) {
      throw new T3McpError(
        "T3_MCP_UPLOAD_ORIGIN_MISMATCH",
        false,
        "Upload URL has a different origin.",
      );
    }
    const response = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": mimeType },
      body: bytes,
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw httpFailure(response.status, "UPLOAD");
  }

  private async call<T>(
    name: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (!this.initialized) {
      await this.post({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "convex-t3-bridge", version: "0.1.0" },
        },
      });
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      this.initialized = true;
    }
    const response = await this.post({
      jsonrpc: "2.0",
      id: ++this.requestId,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const result = response.result;
    const text = result?.content?.find((entry) => entry.type === "text")?.text;
    let payload: unknown = result?.structuredContent;
    if (payload === undefined && text) {
      try {
        payload = JSON.parse(text);
      } catch {
        /* Unstructured tool failures are still failures. */
      }
    }
    if (result?.isError) {
      const failure = z.object({ code: z.string() }).safeParse(payload);
      if (failure.success) {
        const code = failure.data.code;
        // Do not persist or log remote error messages, which may echo credentials.
        throw new T3McpError(
          `T3_MCP_${code.toUpperCase()}`,
          !permanentFailures.has(code),
          `T3 tool ${name} failed.`,
        );
      }
      throw new T3McpError("T3_MCP_TOOL_FAILED", true, `T3 tool ${name} failed.`);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new T3McpError(
        "T3_MCP_INVALID_RESULT",
        false,
        `T3 tool ${name} returned an invalid result.`,
      );
    }
    return parsed.data;
  }

  private async post(request: Record<string, unknown>) {
    const response = await this.fetcher(this.config.t3McpUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${this.config.t3McpToken}`,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw httpFailure(response.status);
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    return parseResponse(await response.text());
  }
}

function httpFailure(status: number, kind = "HTTP") {
  return new T3McpError(
    `T3_MCP_${kind}_${status}`,
    status >= 500 || status === 408 || status === 429,
    "T3 MCP HTTP request failed.",
  );
}

function parseResponse(text: string): z.infer<typeof responseSchema> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (!trimmed.startsWith("{")) {
    const data = trimmed
      .split(/\r?\n/)
      .findLast((line) => line.startsWith("data:") && line.slice(5).trim())
      ?.slice(5)
      .trim();
    if (!data) throw new T3McpError("T3_MCP_INVALID_SSE", true, "No MCP response event.");
    return parseResponse(data);
  }
  const response = responseSchema.parse(JSON.parse(trimmed));
  if (response.error) {
    const code = response.error.code;
    throw new T3McpError(
      "T3_MCP_JSON_RPC_ERROR",
      ![-32600, -32601, -32602].includes(code ?? 0),
      "T3 MCP JSON-RPC request failed.",
    );
  }
  return response;
}

export function isActive(status: string) {
  return ["preparing", "queued", "starting", "running", "waiting"].includes(status);
}

export async function fullItems(
  client: T3McpClient,
  threadId: string,
  items: ThreadItem[],
  renew: () => Promise<void> = async () => {},
) {
  const expanded: ThreadItem[] = [];
  for (const item of items) {
    if (item.type !== "assistant_message") {
      expanded.push(item);
      continue;
    }
    let text = item.text ?? "";
    let next = item.nextTextOffset;
    if (item.textTruncated && next == null) {
      throw new T3McpError(
        "T3_MCP_TEXT_OFFSET_MISSING",
        false,
        "Truncated message has no continuation.",
      );
    }
    while (next != null) {
      await renew();
      const page = await client.readThread({
        threadId,
        itemId: item.itemId,
        textOffset: next,
        limit: 1,
        maxCharsPerItem: 50_000,
      });
      const continuation = page.items.find((entry) => entry.itemId === item.itemId);
      if (
        !continuation ||
        (continuation.nextTextOffset != null && continuation.nextTextOffset <= next)
      ) {
        throw new T3McpError(
          "T3_MCP_TEXT_PAGINATION_STALLED",
          false,
          "Text pagination did not advance.",
        );
      }
      text += continuation.text ?? "";
      next = continuation.nextTextOffset;
    }
    expanded.push({ ...item, text, textTruncated: false, nextTextOffset: null });
  }
  return expanded;
}
