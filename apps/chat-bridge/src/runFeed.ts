/**
 * What one T3 run has done so far, read from the thread's activity: its task
 * rows, whether it waits on a person, and the thread's title. The agent's
 * messages before its newest one are rows too; the newest may be the answer. Each read starts at the run's oldest unfinished item, so rows that
 * change after they first appear are read again.
 */
import { isOpen, noteRow, type TaskRow, taskRow, waitsOnUser } from "./activity.ts";
import type { T3Threads } from "./threads.ts";

export class RunFeed {
  /** The run and any run T3 continued it in after a restart. */
  private readonly runIds = new Set<string>();
  /** Undefined until the first read, which starts a few dozen items back. */
  private cursor: number | undefined;
  private readonly taskRows = new Map<string, TaskRow>();
  /** The agent's messages, as note rows; the newest is held back. */
  private readonly notes = new Map<string, TaskRow>();
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
        const note = noteRow(item);
        if (note !== undefined) this.notes.set(note.id, note);
        continue;
      }
      const row = taskRow(item);
      if (row !== undefined) this.taskRows.set(row.id, row);
    }
    this.waiting = waiting || read.pendingRequests > 0;
    this.cursor = oldestOpen === undefined ? read.lastPosition : oldestOpen - 1;
  }

  /** The task rows, with every agent message but the newest as a note. */
  rows(): Array<TaskRow> {
    const notes = [...this.notes.values()].toSorted((a, b) => a.order - b.order).slice(0, -1);
    return [...this.taskRows.values(), ...notes];
  }
}
