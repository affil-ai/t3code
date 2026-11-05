/**
 * What one T3 run is doing now: its status line, question or permission, the
 * thread's title, and steps finished since the last read. Each read starts at
 * the run's oldest unfinished item, so an item that changes is read again.
 */
import {
  type ActivityItem,
  currentStatus,
  finishedStep,
  isOpen,
  isPermissionRequest,
  isQuestion,
  type RunStep,
  THINKING,
} from "./activity.ts";
import type { T3Threads } from "./threads.ts";

export class RunFeed {
  /** The run and any run T3 continued it in after a restart. */
  private readonly runIds = new Set<string>();
  /** Undefined until the first read, which starts a few dozen items back. */
  private cursor: number | undefined;
  /** The run's unfinished items as of the last read, by id. */
  private readonly open = new Map<string, ActivityItem>();
  private readonly threads: T3Threads;
  private readonly threadId: string;
  /** The thread's title at the last read. */
  title = "";
  /** What the run is doing, as one short line. */
  status = THINKING;
  /** The run asks the person a question. */
  asking = false;
  /** T3 waits on a person: a question, a permission, or a request T3 counts as pending. */
  waiting = false;
  /** The run asks for a permission. */
  askingPermission = false;
  /** The newest position read. */
  lastPosition = -1;
  /** Ids of the steps already handed out, so a re-read item isn't listed twice. */
  private readonly listed = new Set<string>();
  /** Steps that finished since `takeSteps` was last called. */
  private finished: Array<RunStep> = [];

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
    for (const item of read.items) {
      this.lastPosition = Math.max(this.lastPosition, item.position);
      if (item.runId === null || !this.runIds.has(item.runId)) continue;
      if (isOpen(item.status)) {
        this.open.set(item.itemId, item);
        continue;
      }
      this.open.delete(item.itemId);
      const step = this.listed.has(item.itemId) ? undefined : finishedStep(item);
      if (step !== undefined) {
        this.listed.add(item.itemId);
        this.finished.push(step);
      }
    }
    const open = [...this.open.values()].toSorted((a, b) => a.position - b.position);
    this.status = currentStatus(open);
    this.asking = open.some(isQuestion);
    this.askingPermission = open.some(isPermissionRequest);
    this.waiting = this.asking || this.askingPermission || read.pendingRequests > 0;
    const oldestOpen = open[0]?.position;
    this.cursor = oldestOpen === undefined ? read.lastPosition : oldestOpen - 1;
  }

  /** The steps that finished since the last call, oldest first. */
  takeSteps(): ReadonlyArray<RunStep> {
    const steps = this.finished;
    this.finished = [];
    return steps;
  }
}
