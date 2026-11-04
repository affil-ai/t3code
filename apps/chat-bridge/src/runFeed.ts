/**
 * What one T3 run has done so far, read from the thread's activity: its task
 * rows, its assistant text, whether it waits on a person, and the thread's
 * title. Each read starts at the run's oldest unfinished item, so rows that
 * change after they first appear are read again.
 */
import { isOpen, type TaskRow, taskRow, waitsOnUser } from "./activity.ts";
import type { T3Threads } from "./threads.ts";

interface TextItem {
  readonly position: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly open: boolean;
}

export class RunFeed {
  /** The run and any run T3 continued it in after a restart. */
  private readonly runIds = new Set<string>();
  /** Undefined until the first read, which starts a few dozen items back. */
  private cursor: number | undefined;
  private readonly taskRows = new Map<string, TaskRow>();
  private readonly texts = new Map<string, TextItem>();
  /** Whole texts of items cut short in the activity read, read once each. */
  private readonly wholeTexts = new Map<string, string>();
  private readonly threads: T3Threads;
  private readonly threadId: string;
  /** The thread's title at the last read. */
  title = "";
  /** True while T3 waits on a person: a user-input or approval request. */
  waiting = false;
  /** The newest position read, for ordering notes after it. */
  lastPosition = -1;

  constructor(threads: T3Threads, threadId: string, runId: string) {
    this.threads = threads;
    this.threadId = threadId;
    this.runIds.add(runId);
  }

  /** Follows the run into the run T3 continued it in. */
  follow(runId: string): void {
    this.runIds.add(runId);
  }

  async read(): Promise<void> {
    const read = await this.threads.activity(this.threadId, this.cursor);
    this.title = read.title;
    let oldestOpen: number | undefined;
    let waiting = false;
    for (const item of read.items) {
      this.lastPosition = Math.max(this.lastPosition, item.position);
      if (item.runId === null || !this.runIds.has(item.runId)) continue;
      const open = isOpen(item.status);
      if (open) oldestOpen = Math.min(oldestOpen ?? item.position, item.position);
      if (waitsOnUser(item)) waiting = true;
      if (item.type === "assistant_message") {
        this.texts.set(item.itemId, {
          position: item.position,
          text: item.text ?? "",
          truncated: item.textTruncated === true,
          open,
        });
        continue;
      }
      const row = taskRow(item);
      if (row !== undefined) this.taskRows.set(row.id, row);
    }
    this.waiting = waiting || read.pendingRequests > 0;
    this.cursor = oldestOpen === undefined ? read.lastPosition : oldestOpen - 1;
  }

  rows(): Array<TaskRow> {
    return [...this.taskRows.values()];
  }

  /**
   * The run's assistant messages joined by blank lines. A finished message
   * the read cut short is read whole; one still being written stays cut until
   * it finishes, so the text only grows. `whole` reads every message whole.
   */
  async text(whole = false): Promise<string> {
    const items = [...this.texts.entries()].toSorted(([, a], [, b]) => a.position - b.position);
    const parts: Array<string> = [];
    for (const [itemId, item] of items) {
      let text = item.text;
      if (item.truncated && (whole || !item.open)) {
        text = this.wholeTexts.get(itemId) ?? (await this.threads.itemText(this.threadId, itemId));
        this.wholeTexts.set(itemId, text);
      }
      const trimmed = text.trim();
      if (trimmed !== "") parts.push(trimmed);
    }
    return parts.join("\n\n");
  }
}
