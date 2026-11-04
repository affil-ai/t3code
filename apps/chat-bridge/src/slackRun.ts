/**
 * One T3 run in a Slack thread: task rows streamed into a plan, a plan block
 * once the run outlasts Slack's 10-minute stream, and the final answer as the
 * reply's text.
 */
import { SlackFormatConverter } from "@chat-adapter/slack";

import type { TaskRow, TaskStatus } from "./activity.ts";
import type { RunDisplay, RunEnd, RunProgress } from "./bridge.ts";
import { splitMarkdown } from "./slackText.ts";

/** A Slack Web API call; throws with `data.error` when Slack answers `ok: false`. */
export type SlackApi = (
  method: string,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Slack ends a stream 10 minutes after it starts; close it a minute before. */
export const STREAM_MAX_MS = 9 * 60_000;
/** A plan block is updated at most this often while the run goes. */
export const PLAN_UPDATE_MS = 15_000;
/** Slack takes 12,000 characters of text over a whole stream; leave room. */
export const STREAM_TEXT_BUDGET = 11_000;
/** Slack keeps the first 50 task ids in a stream and 50 tasks in a plan block. */
const TASK_LIMIT = 50;
const MORE_ID = "more";
const EARLIER_ID = "earlier";

/** Errors after which the stream takes no more: it expired, someone stopped it, or it is gone. */
const STREAM_GONE = new Set([
  "message_not_in_streaming_state",
  "stopped_by_user",
  "message_not_found",
  "message_not_owned_by_app",
]);

export const slackErrorCode = (error: unknown): string | undefined =>
  (error as { data?: { error?: string } } | undefined)?.data?.error;

export interface SlackRunOptions {
  readonly channel: string;
  readonly threadTs: string;
  /** Slack streams a reply in a channel only to a named person. */
  readonly recipient?: { readonly userId: string; readonly teamId: string } | undefined;
  readonly api: SlackApi;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** A row's status once the run is over: what was still going finished, or was cut off. */
const settled = (status: TaskStatus, failed: boolean): TaskStatus =>
  status === "pending" || status === "in_progress" ? (failed ? "error" : "complete") : status;

const taskChunk = (row: Pick<TaskRow, "id" | "title" | "status" | "output">) => ({
  type: "task_update",
  id: row.id,
  title: row.title,
  status: row.status,
  ...(row.output ? { output: row.output } : {}),
});

const richText = (text: string) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
});

/** The status a group of rows shows as one: going if any is, failed if any did. */
function groupStatus(rows: ReadonlyArray<TaskRow>): TaskStatus {
  if (rows.some((row) => row.status === "in_progress" || row.status === "pending"))
    return "in_progress";
  return rows.some((row) => row.status === "error") ? "error" : "complete";
}

/** A plan block of the rows; past 50, the oldest fold into one row. */
export function planBlock(rows: ReadonlyArray<TaskRow>, title: string): Record<string, unknown> {
  const kept = rows.length > TASK_LIMIT ? rows.slice(rows.length - (TASK_LIMIT - 1)) : rows;
  const folded = rows.slice(0, rows.length - kept.length);
  const tasks = [
    ...(folded.length > 0
      ? [
          {
            task_id: EARLIER_ID,
            title: `${folded.length} earlier steps`,
            status: groupStatus(folded),
          },
        ]
      : []),
    ...kept.map((row) => ({
      task_id: row.id,
      title: row.title,
      status: row.status,
      ...(row.output ? { output: richText(row.output) } : {}),
    })),
  ];
  return { type: "plan", title, tasks };
}

/** The plan's title, which Slack also shows as "Tasks performed: …". */
export function planTitle(steps: number, final: boolean, failed: boolean): string {
  const count = `${steps} step${steps === 1 ? "" : "s"}`;
  if (!final) return "Working";
  return failed ? `Stopped after ${count}` : `Completed ${count}`;
}

/**
 * A title Slack takes. Slack refuses some characters in session titles with
 * `invalid_name`, such as square brackets and colons (checked 2026-11-04), so
 * a colon becomes a dash; `strict` keeps only plain characters.
 */
export function slackTitle(title: string, strict = false): string {
  const cleaned = strict
    ? title.replace(/[^\p{L}\p{N} .,?!'’()&+-]/gu, " ")
    : title.replace(/[[\]{}<>#|\\`*~]/g, " ").replace(/\s*[:;/]\s*/g, " - ");
  return cleaned.replace(/\s+/g, " ").trim().slice(0, 200);
}

const converter = new SlackFormatConverter();

/** What the display sends: the rows, and the answer's text once the run has ended. */
interface View {
  readonly rows: ReadonlyArray<TaskRow>;
  readonly text: string;
}

export class SlackRunDisplay implements RunDisplay {
  private mode: "waiting" | "stream" | "plan" | "closed" = "waiting";
  private streamTs: string | undefined;
  private streamStartedAt = 0;
  /** The answer text the stream has carried. */
  private streamed = "";
  /** The stream takes no more text: over budget, or it closed early. */
  private textDone = false;
  private planTitled = false;
  /** Each row as last sent to the stream, by id. */
  private readonly sentRows = new Map<string, string>();
  private planTs: string | undefined;
  private planSent = "";
  private planSentAt = 0;
  /** Parts of the answer already posted, so a retried finish does not post them again. */
  private postedParts = 0;
  private noticePosted = false;
  private failed = false;
  private readonly options: SlackRunOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: SlackRunOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  async progress(progress: RunProgress): Promise<void> {
    await this.show({ rows: progress.rows, text: "" }, false);
  }

  async finish(end: RunEnd): Promise<void> {
    const failed = end.notice !== undefined;
    this.failed = failed;
    const rows = end.rows.map((row) => ({ ...row, status: settled(row.status, failed) }));
    const answer = end.answer ?? "";
    await this.show({ rows, text: answer }, true);
    if (this.mode === "stream") {
      await this.stopStream(
        this.planTitled
          ? { chunks: [{ type: "plan_update", title: planTitle(rows.length, true, failed) }] }
          : {},
      );
    }
    this.mode = "closed";
    // What of the answer the stream had no room for, or all of it when there was no stream.
    const rest = answer.startsWith(this.streamed)
      ? answer.slice(this.streamed.length).trim()
      : answer;
    const parts = rest === "" ? [] : splitMarkdown(rest);
    for (const [index, part] of parts.entries()) {
      if (index < this.postedParts) continue;
      await this.postMarkdown(part);
      this.postedParts = index + 1;
    }
    if (end.notice !== undefined && !this.noticePosted) {
      await this.postMarkdown(end.notice);
      this.noticePosted = true;
    }
  }

  private canStream(): boolean {
    return this.options.channel.startsWith("D") || this.options.recipient !== undefined;
  }

  private async show(progress: View, final: boolean): Promise<void> {
    if (this.mode === "waiting") {
      if (progress.rows.length === 0 && progress.text === "") return;
      if (this.canStream()) await this.startStream(progress);
      else this.mode = "plan";
    }
    if (this.mode === "stream" && this.now() - this.streamStartedAt >= STREAM_MAX_MS) {
      await this.closeStreamForPlan(progress.rows);
    }
    if (this.mode === "stream") await this.appendStream(progress);
    if (this.mode === "plan") await this.updatePlan(progress.rows, final);
  }

  /** The rows that changed since they were last sent; new rows past Slack's limit fold into one. */
  private rowChunks(rows: ReadonlyArray<TaskRow>) {
    const chunks: Array<Record<string, unknown>> = [];
    const sent: Array<readonly [string, string]> = [];
    const overflow: Array<TaskRow> = [];
    // One id is kept for the folded row.
    let room = TASK_LIMIT - 1 - [...this.sentRows.keys()].filter((id) => id !== MORE_ID).length;
    const add = (row: Pick<TaskRow, "id" | "title" | "status" | "output">) => {
      const chunk = taskChunk(row);
      const key = JSON.stringify(chunk);
      if (this.sentRows.get(row.id) === key) return;
      chunks.push(chunk);
      sent.push([row.id, key]);
    };
    for (const row of rows) {
      if (!this.sentRows.has(row.id)) {
        if (room <= 0) {
          overflow.push(row);
          continue;
        }
        room -= 1;
      }
      add(row);
    }
    if (overflow.length > 0) {
      add({ id: MORE_ID, title: `${overflow.length} more steps`, status: groupStatus(overflow) });
    }
    if (!this.planTitled && chunks.length > 0) {
      chunks.unshift({ type: "plan_update", title: planTitle(rows.length, false, false) });
    }
    return {
      chunks,
      commit: () => {
        for (const [id, key] of sent) this.sentRows.set(id, key);
        if (chunks.length > 0) this.planTitled = true;
      },
    };
  }

  /** The text not yet streamed, up to the budget, cut at a line break when it runs out. */
  private textDelta(text: string) {
    if (this.textDone) return { delta: "", commit: () => {} };
    if (!text.startsWith(this.streamed)) {
      this.textDone = true;
      return { delta: "", commit: () => {} };
    }
    let delta = text.slice(this.streamed.length);
    const room = STREAM_TEXT_BUDGET - this.streamed.length;
    let full = false;
    if (delta.length > room) {
      const cut = delta.lastIndexOf("\n", room);
      delta = cut > 0 ? delta.slice(0, cut) : "";
      full = true;
    }
    return {
      delta,
      commit: () => {
        this.streamed += delta;
        if (full) this.textDone = true;
      },
    };
  }

  private chunksFor(progress: View) {
    const rows = this.rowChunks(progress.rows);
    const text = this.textDelta(progress.text);
    const chunks = [
      ...rows.chunks,
      ...(text.delta === "" ? [] : [{ type: "markdown_text", text: text.delta }]),
    ];
    return {
      chunks,
      commit: () => {
        rows.commit();
        text.commit();
      },
    };
  }

  private target() {
    return { channel: this.options.channel, thread_ts: this.options.threadTs };
  }

  private async startStream(progress: View): Promise<void> {
    const { chunks, commit } = this.chunksFor(progress);
    if (chunks.length === 0) return;
    const recipient = this.options.recipient;
    try {
      const started = await this.options.api("chat.startStream", {
        ...this.target(),
        task_display_mode: "plan",
        ...(recipient
          ? { recipient_user_id: recipient.userId, recipient_team_id: recipient.teamId }
          : {}),
        chunks,
      });
      this.streamTs = String(started.ts);
      this.streamStartedAt = this.now();
      this.mode = "stream";
      commit();
    } catch (error) {
      this.log(
        `Streaming in ${this.options.channel} failed (${slackErrorCode(error) ?? String(error)}); showing a plan block instead.`,
      );
      this.mode = "plan";
    }
  }

  private async appendStream(progress: View): Promise<void> {
    const { chunks, commit } = this.chunksFor(progress);
    if (chunks.length === 0) return;
    try {
      await this.options.api("chat.appendStream", {
        channel: this.options.channel,
        ts: this.streamTs,
        chunks,
      });
      commit();
    } catch (error) {
      this.streamFailed(error);
    }
  }

  /** A stream that is gone takes nothing more; anything else is tried again on the next check. */
  private streamFailed(error: unknown): void {
    const code = slackErrorCode(error);
    if (code !== undefined && STREAM_GONE.has(code)) {
      this.log(`The stream in ${this.options.channel} ended (${code}).`);
      // Someone pressed stop; the run is being stopped, so nothing more is shown.
      this.mode = code === "stopped_by_user" ? "closed" : "plan";
      return;
    }
    this.log(`Updating the stream in ${this.options.channel} failed: ${code ?? String(error)}`);
  }

  private async stopStream(args: Record<string, unknown>): Promise<void> {
    try {
      await this.options.api("chat.stopStream", {
        channel: this.options.channel,
        ts: this.streamTs,
        ...args,
      });
    } catch (error) {
      const code = slackErrorCode(error);
      if (code === undefined || !STREAM_GONE.has(code)) throw error;
    }
  }

  /** Ends the stream before Slack does, and goes on in a plan block. */
  private async closeStreamForPlan(rows: ReadonlyArray<TaskRow>): Promise<void> {
    const open = rows
      .filter((row) => this.sentRows.has(row.id))
      .filter((row) => row.status === "in_progress" || row.status === "pending")
      // Still going: say where it goes on, without calling it done.
      .map((row) => taskChunk({ ...row, output: "Continues in the next message." }));
    try {
      await this.stopStream({
        ...(open.length > 0 ? { chunks: open } : {}),
        session_status: "processing",
      });
    } catch (error) {
      this.log(`Closing the stream in ${this.options.channel} failed: ${String(error)}`);
    }
    this.textDone = true;
    this.mode = "plan";
  }

  private async updatePlan(rows: ReadonlyArray<TaskRow>, final: boolean): Promise<void> {
    if (rows.length === 0) return;
    const block = planBlock(rows, planTitle(rows.length, final, this.failed));
    const key = JSON.stringify(block);
    if (key === this.planSent) return;
    if (this.planTs !== undefined && !final && this.now() - this.planSentAt < PLAN_UPDATE_MS)
      return;
    // Slack shows this text in notifications and search.
    const fallback = final
      ? planTitle(rows.length, true, this.failed)
      : `Working: ${rows.length} steps so far`;
    try {
      if (this.planTs === undefined) {
        const posted = await this.options.api("chat.postMessage", {
          ...this.target(),
          text: fallback,
          blocks: [block],
        });
        this.planTs = String(posted.ts);
      } else {
        await this.options.api("chat.update", {
          channel: this.options.channel,
          ts: this.planTs,
          text: fallback,
          blocks: [block],
        });
      }
      this.planSent = key;
      this.planSentAt = this.now();
    } catch (error) {
      this.log(
        `Updating the plan in ${this.options.channel} failed: ${slackErrorCode(error) ?? String(error)}`,
      );
    }
  }

  /** Posts markdown as a reply. */
  private async postMarkdown(markdown: string): Promise<void> {
    const payload = converter.toSlackPayload({ markdown }) as { markdown_text?: string };
    await this.options.api("chat.postMessage", {
      ...this.target(),
      text: converter.toResponseUrlText({ markdown }).slice(0, 3_000),
      blocks: [{ type: "markdown", text: payload.markdown_text ?? markdown }],
    });
  }
}
