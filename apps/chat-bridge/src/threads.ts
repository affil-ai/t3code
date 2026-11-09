/**
 * The T3 thread operations the bridge needs, as calls to T3's MCP tools.
 */
import type { ModelSelection } from "./modelCommand.ts";
import type { ActivityItem } from "./activity.ts";
import type { Answer, Question } from "./questions.ts";
import type { T3Tools } from "./t3Client.ts";

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
  readonly modelSelection?: ModelSelection | undefined;
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
/** Activity rows show a short output, so an item needs only its start. */
const ACTIVITY_CHARS = 1_000;
/** A watch that starts mid-thread reads this many items back for its run's earlier work. */
const ACTIVITY_LOOKBACK = 40;
/** Pages read per activity call; a busier tick catches up on the next one. */
const ACTIVITY_PAGES = 5;

interface ReadItem {
  readonly position: number;
  readonly itemId: string;
  readonly type: string;
  readonly runId: string | null;
  readonly status?: string | undefined;
  readonly title?: string | null | undefined;
  readonly text: string | null;
  readonly textTruncated?: boolean | undefined;
  readonly nextTextOffset?: number | null;
}

interface ReadResult {
  readonly thread: {
    readonly projectId: string;
    readonly worktreePath: string | null;
    readonly title?: string | undefined;
    readonly itemCount?: number | undefined;
    readonly pendingRequestCount?: number | undefined;
  };
  readonly items: ReadonlyArray<ReadItem>;
  readonly nextPosition: number | null;
  readonly hasMore: boolean;
}

/** What the bridge needs to know about a thread it didn't start, such as a subagent. */
export interface ThreadShape {
  readonly projectId: string;
  readonly title: string;
  readonly parentThreadId: string | null;
  /** `subagent` for a child `delegate_task` made. */
  readonly relationshipToParent: string | null;
  readonly latestRun: { readonly runId: string; readonly status: RunStatus } | undefined;
}

/** A thread's activity after a position, with what the thread looks like now. */
export interface ActivityRead {
  readonly title: string;
  /** User-input and approval requests T3 is waiting on. */
  readonly pendingRequests: number;
  readonly items: ReadonlyArray<ActivityItem>;
  /** Pass back as `afterPosition` to read on from here. */
  readonly lastPosition: number;
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
  /** The server names one pending-request tool per action. */
  private splitPendingTools = false;

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
    /** A new worktree from this branch on origin; without it, the project's checkout. */
    readonly worktreeFrom?: string | undefined;
    /** Overrides the configured model for this thread. */
    readonly modelSelection?: ModelSelection | undefined;
  }): Promise<{ readonly threadId: string; readonly runId: string | null }> {
    const result = await this.t3.call<{ threadId: string; runId: string | null }>(
      "t3_thread_launch",
      {
        projectId: input.projectId,
        title: input.title,
        message: input.text,
        ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
        ...(input.worktreeFrom === undefined
          ? {}
          : {
              workspaceStrategy: {
                type: "worktree",
                baseRef: input.worktreeFrom,
                startFromOrigin: true,
              },
            }),
        ...(this.launchOptions.runtimeMode ? { runtimeMode: this.launchOptions.runtimeMode } : {}),
        ...(input.modelSelection
          ? { modelSelection: input.modelSelection }
          : this.launchOptions.modelSelection
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
   * way T3 sends attachments, which steers as `auto` does. `requestId` makes a
   * retried send return the message the first one made, with or without files.
   */
  async send(input: {
    readonly threadId: string;
    readonly text: string;
    readonly attachments: ReadonlyArray<T3Attachment>;
    readonly requestId: string;
  }): Promise<{ readonly runId: string; readonly delivery: Delivery }> {
    if (input.attachments.length === 0) {
      return this.t3.call("t3_thread_send", {
        threadId: input.threadId,
        message: input.text,
        // `auto` steers the run in flight, or starts one when the thread is idle. T3
        // decides when it dispatches, so a run that ends at that moment can't refuse it.
        mode: "auto",
        clientRequestId: input.requestId,
      });
    }
    const sent = await this.t3.call<{ runId: string }>("t3_thread_send_attachments", {
      threadId: input.threadId,
      message: input.text,
      attachments: input.attachments,
      clientRequestId: input.requestId,
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

  /**
   * Waits until the run's subagents and background work, and the runs T3
   * starts when they report back, have all finished. `timedOut` means some
   * are still going.
   */
  async waitForDelegatedWork(
    threadId: string,
    runId: string,
    timeoutMs: number,
  ): Promise<{ readonly timedOut: boolean }> {
    const result = await this.t3.call<{ timedOut?: boolean }>(
      "t3_thread_wait",
      { threadId, runId, timeoutMs, untilDelegatedWorkSettled: true },
      { timeoutMs: timeoutMs + 30_000 },
    );
    return { timedOut: result.timedOut === true };
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

    const text = (await this.itemText(threadId, answer.itemId)).trim();
    return text === "" ? undefined : text;
  }

  /** One item's text, up to 50,000 characters. */
  async itemText(threadId: string, itemId: string): Promise<string> {
    const full = await this.t3.call<ReadResult>("t3_thread_read", {
      threadId,
      itemId,
      view: "activity",
      runLimit: 1,
      maxCharsPerItem: MAX_ANSWER_CHARS,
    });
    return full.items.find((each) => each.itemId === itemId)?.text ?? "";
  }

  /**
   * The thread's activity items after `afterPosition` (-1 for all), each cut
   * to its first 1,000 characters. Without a position it starts a few dozen
   * items back from the end, so watching a long thread doesn't read all of it.
   */
  async activity(threadId: string, afterPosition: number | undefined): Promise<ActivityRead> {
    let after: number = afterPosition ?? (await this.lookbackStart(threadId));
    const items: Array<ActivityItem> = [];
    let thread: ReadResult["thread"] | undefined;
    for (let page = 0; page < ACTIVITY_PAGES; page++) {
      const read: ReadResult = await this.t3.call<ReadResult>("t3_thread_read", {
        threadId,
        view: "activity",
        limit: 100,
        runLimit: 1,
        maxCharsPerItem: ACTIVITY_CHARS,
        ...(after < 0 ? {} : { afterPosition: after }),
      });
      thread = read.thread;
      for (const item of read.items) {
        items.push({
          position: item.position,
          itemId: item.itemId,
          type: item.type,
          runId: item.runId,
          status: item.status ?? "completed",
          title: item.title ?? null,
          text: item.text,
          textTruncated: item.textTruncated,
        });
        after = item.position;
      }
      if (!read.hasMore || read.nextPosition === null) break;
      after = read.nextPosition;
    }
    return {
      title: thread?.title ?? "",
      pendingRequests: thread?.pendingRequestCount ?? 0,
      items,
      lastPosition: after,
    };
  }

  /** The position a few dozen items before the thread's end, or -1 for a short thread. */
  private async lookbackStart(threadId: string): Promise<number> {
    const head = await this.t3.call<ReadResult>("t3_thread_read", {
      threadId,
      view: "activity",
      limit: 1,
      runLimit: 1,
      maxCharsPerItem: 1,
    });
    return Math.max(-1, (head.thread.itemCount ?? 0) - ACTIVITY_LOOKBACK - 1);
  }

  /** The thread's questions waiting for an answer, each with its parts. */
  async pendingQuestions(
    threadId: string,
  ): Promise<Array<{ readonly requestId: string; readonly questions: ReadonlyArray<Question> }>> {
    const listed = await this.pendingRequest<{ requestIds: ReadonlyArray<string> }>("list", {
      threadId,
    });
    const pending = [];
    for (const requestId of listed.requestIds) {
      const read = await this.pendingRequest<{ questions: ReadonlyArray<Question> }>("read", {
        threadId,
        requestId,
      });
      pending.push({ requestId, questions: read.questions });
    }
    return pending;
  }

  /** Answers a pending question, so the run carries on. */
  async answerQuestions(
    threadId: string,
    requestId: string,
    answers: Readonly<Record<string, Answer>>,
  ): Promise<void> {
    await this.pendingRequest("respond", { threadId, requestId, answers });
  }

  /**
   * Calls `t3_pending_request` with an action. T3 servers from before the
   * tools were merged name one tool per action (`t3_pending_request_list`);
   * the first "not found" switches to those for the rest of the session.
   */
  private async pendingRequest<T>(
    action: "list" | "read" | "respond",
    args: Record<string, unknown>,
  ): Promise<T> {
    if (!this.splitPendingTools) {
      try {
        return await this.t3.call<T>("t3_pending_request", { action, ...args });
      } catch (error) {
        if (!/Tool 't3_pending_request' not found/.test(String(error))) throw error;
        this.splitPendingTools = true;
      }
    }
    return this.t3.call<T>(`t3_pending_request_${action}`, args);
  }

  /** The thread's provider, model and options. */
  async modelSelection(threadId: string): Promise<ModelSelection> {
    const read = await this.t3.call<{ modelSelection: ModelSelection }>("t3_thread_configure", {
      threadId,
    });
    return read.modelSelection;
  }

  /** Sets the model and options the thread's next turn runs with. */
  async setModel(threadId: string, modelSelection: ModelSelection): Promise<void> {
    await this.t3.call("t3_thread_configure", { threadId, modelSelection });
  }

  /** Asks T3 to write a short title for the thread from its conversation. */
  async regenerateTitle(threadId: string): Promise<void> {
    await this.t3.call("t3_thread_update", { threadId, action: "regenerate_title" });
  }

  /** Stops the thread's running turn; nothing happens when it is idle. */
  async interrupt(threadId: string, reason: string): Promise<void> {
    await this.t3.call("t3_thread_interrupt", { threadId, reason });
  }

  /** The thread's project, parent and latest run. */
  async shape(threadId: string): Promise<ThreadShape> {
    const read = await this.t3.call<{
      readonly thread: {
        readonly projectId: string;
        readonly title?: string;
        readonly parentThreadId?: string | null;
        readonly relationshipToParent?: string | null;
      };
      readonly recentRuns?: ReadonlyArray<{
        readonly runId: string;
        readonly ordinal: number;
        readonly status: RunStatus;
      }>;
    }>("t3_thread_read", { threadId, view: "messages", limit: 1, runLimit: 5, maxCharsPerItem: 1 });
    const latest = [...(read.recentRuns ?? [])].toSorted((a, b) => b.ordinal - a.ordinal)[0];
    return {
      projectId: read.thread.projectId,
      title: read.thread.title ?? "",
      parentThreadId: read.thread.parentThreadId ?? null,
      relationshipToParent: read.thread.relationshipToParent ?? null,
      latestRun: latest === undefined ? undefined : { runId: latest.runId, status: latest.status },
    };
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
