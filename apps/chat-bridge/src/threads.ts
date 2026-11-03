/**
 * The T3 thread operations the bridge needs, as calls to T3's MCP tools.
 */
import type { T3Tools } from "./t3Client.ts";

export type FollowUpMode = "steer" | "queue";
export type Delivery = "started" | "queued" | "steered" | "restarted" | "sent";

/** A pending T3 attachment, as `t3_thread_launch` and `t3_thread_send_attachments` take it. */
export interface T3Attachment {
  readonly type: "image" | "file";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/** A file attached to a chat message. `fetch` downloads it with the bot's credentials. */
export interface InboundFile {
  readonly name: string;
  readonly mimeType: string | undefined;
  readonly sizeBytes: number | undefined;
  readonly fetch: (() => Promise<Uint8Array>) | undefined;
}

export interface ImportedFiles {
  readonly attachments: ReadonlyArray<T3Attachment>;
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

export type RunStatus =
  | "idle"
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

export const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export interface LaunchOptions {
  readonly runtimeMode?: string | undefined;
  readonly modelSelection?: Record<string, unknown> | undefined;
}

// T3's limits for message attachments.
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const MAX_ATTACHMENTS = 8;
const NAME_LIMIT = 255;
const MIME_LIMIT = 100;
const SCAN_PAGE = 100;
const MAX_ANSWER_CHARS = 50_000;

interface ReadItem {
  readonly position: number;
  readonly itemId: string;
  readonly type: string;
  readonly runId: string | null;
  readonly text: string | null;
  readonly nextTextOffset?: number | null;
}

interface ReadResult {
  readonly thread: { readonly projectId: string; readonly worktreePath: string | null };
  readonly items: ReadonlyArray<ReadItem>;
  readonly nextPosition: number | null;
  readonly hasMore: boolean;
}

function attachmentName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "file" : trimmed.slice(0, NAME_LIMIT);
}

function mimeTypeOf(file: InboundFile): string {
  const mimeType = file.mimeType?.trim().toLowerCase() ?? "";
  return mimeType === "" || mimeType.length > MIME_LIMIT ? "application/octet-stream" : mimeType;
}

export class T3Threads {
  private readonly t3: T3Tools;
  private readonly launchOptions: LaunchOptions;
  private readonly log: (line: string) => void;

  constructor(
    t3: T3Tools,
    launchOptions: LaunchOptions = {},
    log: (line: string) => void = () => {},
  ) {
    this.t3 = t3;
    this.launchOptions = launchOptions;
    this.log = log;
  }

  /** Starts a thread on the message. `requestId` makes a retried launch return the same thread. */
  async start(input: {
    readonly projectId: string;
    readonly title: string;
    readonly text: string;
    readonly attachments: ReadonlyArray<T3Attachment>;
    readonly requestId: string;
  }): Promise<{ readonly threadId: string; readonly runId: string | null }> {
    const result = await this.t3.call<{ threadId: string; runId: string | null }>(
      "t3_thread_launch",
      {
        projectId: input.projectId,
        title: input.title,
        message: input.text,
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        ...(this.launchOptions.runtimeMode ? { runtimeMode: this.launchOptions.runtimeMode } : {}),
        ...(this.launchOptions.modelSelection
          ? { modelSelection: this.launchOptions.modelSelection }
          : {}),
        clientRequestId: input.requestId,
      },
    );
    return { threadId: result.threadId, runId: result.runId };
  }

  /**
   * Sends a follow-up. `steer` joins the run in flight, or starts one when the
   * thread is idle; `queue` runs after it. A message with files is sent the
   * way T3 sends attachments, which steers as `auto` does.
   */
  async send(input: {
    readonly threadId: string;
    readonly text: string;
    readonly attachments: ReadonlyArray<T3Attachment>;
    readonly mode: FollowUpMode;
    readonly requestId: string;
  }): Promise<{ readonly runId: string; readonly delivery: Delivery }> {
    if (input.attachments.length === 0) {
      return this.t3.call("t3_thread_send", {
        threadId: input.threadId,
        message: input.text,
        // T3's `steer` fails when no run is in flight; `auto` steers one or starts one.
        mode: input.mode === "steer" ? "auto" : "queue",
        clientRequestId: input.requestId,
      });
    }
    const sent = await this.t3.call<{ runId: string }>("t3_thread_send_attachments", {
      threadId: input.threadId,
      message: input.text,
      attachments: input.attachments,
    });
    return { runId: sent.runId, delivery: "sent" };
  }

  /** Uploads chat files as pending T3 attachments. A file that fails is skipped, not fatal. */
  async importFiles(files: ReadonlyArray<InboundFile>): Promise<ImportedFiles> {
    const attachments: Array<T3Attachment> = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const file of files) {
      const name = attachmentName(file.name);
      if (attachments.length >= MAX_ATTACHMENTS) {
        skipped.push({ name, reason: `more than ${MAX_ATTACHMENTS} files` });
        continue;
      }
      try {
        const result = await this.importOne(file, name);
        if ("attachment" in result) attachments.push(result.attachment);
        else skipped.push({ name, reason: result.reason });
      } catch (error) {
        this.log(`Could not import ${name}: ${String(error)}`);
        skipped.push({ name, reason: "upload failed" });
      }
    }
    return { attachments, skipped };
  }

  private async importOne(
    file: InboundFile,
    name: string,
  ): Promise<{ attachment: T3Attachment } | { reason: string }> {
    const maxMb = MAX_FILE_BYTES / (1024 * 1024);
    if (file.sizeBytes !== undefined && file.sizeBytes > MAX_FILE_BYTES) {
      return { reason: `larger than ${maxMb} MB` };
    }
    if (file.fetch === undefined) return { reason: "no download link" };
    const bytes = await file.fetch();
    if (bytes.byteLength === 0) return { reason: "empty" };
    if (bytes.byteLength > MAX_FILE_BYTES) return { reason: `larger than ${maxMb} MB` };

    const mimeType = mimeTypeOf(file);
    // Supported images under the image limit go to the model as images; everything else as a file.
    const type =
      IMAGE_MIME_TYPES.has(mimeType) && bytes.byteLength <= MAX_IMAGE_BYTES ? "image" : "file";
    const prepared = await this.t3.call<{ attachmentId: string; relativeUrl: string }>(
      "t3_attachment_prepare_upload",
      { upload: { type, name, mimeType, sizeBytes: bytes.byteLength } },
    );
    await this.t3.upload(prepared.relativeUrl, bytes);
    return {
      attachment: { type, id: prepared.attachmentId, name, mimeType, sizeBytes: bytes.byteLength },
    };
  }

  /**
   * Waits up to `timeoutMs` for a run to end. T3 follows a restarted run to
   * its continuation, so the returned `runId` can differ from the one passed.
   */
  async waitForRun(
    threadId: string,
    runId: string,
    timeoutMs: number,
  ): Promise<{ readonly runId: string; readonly status: RunStatus; readonly timedOut: boolean }> {
    const result = await this.t3.call<{
      runId: string | null;
      status: RunStatus;
      timedOut: boolean;
    }>(
      "t3_thread_wait",
      { threadId, runId, timeoutMs },
      // T3 answers when the wait times out; leave room for that reply.
      { timeoutMs: timeoutMs + 30_000 },
    );
    return { runId: result.runId ?? runId, status: result.status, timedOut: result.timedOut };
  }

  /** The run's last assistant message, or nothing if the run ended without one. */
  async finalAnswer(threadId: string, runId: string): Promise<string | undefined> {
    // Scan with one character per item to find the message, then read it whole.
    let afterPosition: number | undefined;
    let answer: ReadItem | undefined;
    for (;;) {
      const page = await this.t3.call<ReadResult>("t3_thread_read", {
        threadId,
        view: "messages",
        limit: SCAN_PAGE,
        runLimit: 1,
        maxCharsPerItem: 1,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      });
      for (const item of page.items) {
        if (item.type === "assistant_message" && item.runId === runId) answer = item;
      }
      if (!page.hasMore || page.nextPosition === null) break;
      afterPosition = page.nextPosition;
    }
    if (answer === undefined) return undefined;

    const full = await this.t3.call<ReadResult>("t3_thread_read", {
      threadId,
      itemId: answer.itemId,
      view: "messages",
      runLimit: 1,
      maxCharsPerItem: MAX_ANSWER_CHARS,
    });
    const item = full.items.find((each) => each.itemId === answer.itemId);
    const text = item?.text?.trim() ?? "";
    return text === "" ? undefined : text;
  }

  /** The folders a thread may share files from: its worktree, or its project's checkout. */
  async workspaceRoots(threadId: string): Promise<ReadonlyArray<string>> {
    const read = await this.t3.call<ReadResult>("t3_thread_read", {
      threadId,
      view: "messages",
      limit: 1,
      runLimit: 1,
      maxCharsPerItem: 1,
    });
    const project = await this.t3.call<{ workspaceRoot?: string | null }>("t3_project_read", {
      projectId: read.thread.projectId,
    });
    return [read.thread.worktreePath, project.workspaceRoot].filter(
      (root): root is string => typeof root === "string" && root !== "",
    );
  }
}
