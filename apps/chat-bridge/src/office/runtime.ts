// @effect-diagnostics globalFetch:off globalTimers:off -- A plain Node app; it does not use Effect.
/**
 * Office's agent runtime, in place of the Office T3 worker, on Office's existing agentHost functions.
 * Each run is watched on its own and each event applied on its own; an event Office refuses is logged
 * and skipped, never retried forever. A restart re-reads T3 and Office ignores what it already has.
 */
import { type ActivityItem, isOpen } from "../activity.ts";
import type { ModelSelection } from "../modelCommand.ts";
import { type RunStatus, TERMINAL_STATUSES, type T3Threads } from "../threads.ts";
import {
  type Claim,
  type OfficeApi,
  OfficeConvexError,
  type OfficeFile,
  type OfficeModelSelection,
  type WorkRef,
} from "./convex.ts";
import { formatRequest } from "./message.ts";
import { type TimelineEntry, timelineEntry } from "./timeline.ts";

export interface OfficeRuntimeOptions {
  readonly office: OfficeApi;
  readonly threads: T3Threads;
  /** The T3 project new Office conversations start in. */
  readonly projectId: string;
  /** This runtime's name to Office; Office routes a chat's turns to the runtime that started it. */
  readonly environmentId: string;
  /** New conversations get a worktree from this branch; without it, the project's checkout. */
  readonly worktreeFrom?: string | undefined;
  /** What Office records when a claim names no model. */
  readonly defaultModel: OfficeModelSelection;
  readonly log: (line: string) => void;
  readonly fetchFile?: (url: string) => Promise<Uint8Array>;
  readonly now?: () => number;
}

/** Office allows this many events per call. */
const EVENT_BATCH = 20;
/** A claim that keeps failing before T3 takes it fails the run on this attempt. */
const MAX_ATTEMPTS = 3;
const WAIT_SLICE_MS = 1_500;

interface Watch {
  readonly bindingId: string;
  readonly threadId: string;
  /** Office's id for the turn: the T3 run it started. */
  readonly providerTurnId: string;
  /** T3 runs that belong to the turn: the first, and any T3 restarted it as. */
  readonly runIds: Set<string>;
  /** Read from after here: just before the oldest item still going. */
  cursor: number | undefined;
  /** The highest `seqEnd` Office has for each item. */
  readonly sent: Map<string, number>;
  lastAnswerKey: string | undefined;
  finished: boolean;
}

const fetchBytes = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

export class OfficeRuntime {
  private readonly options: OfficeRuntimeOptions;
  private readonly watches = new Map<string, Watch>();
  /** Runs being claimed or started now, so a second poll doesn't start them twice. */
  private readonly starting = new Set<string>();
  private readonly interrupted = new Set<string>();
  private readonly now: () => number;

  constructor(options: OfficeRuntimeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private log(line: string): void {
    this.options.log(`Office: ${line}`);
  }

  /** One pass: start queued turns, stop canceled ones, and report on the runs being watched. */
  async tick(): Promise<void> {
    const pending = await this.options.office.pendingWork(this.options.environmentId);
    const starts = [
      ...pending.provisions.map((ref) => this.start(ref, "provision")),
      ...pending.dispatches.map((ref) => this.start(ref, "dispatch")),
    ];
    // After a restart, Office still lists the turns it was waiting on.
    for (const subscription of pending.subscriptions) {
      for (const providerTurnId of subscription.activeProviderTurnIds) {
        this.watch(subscription.bindingId, subscription.threadId, providerTurnId);
      }
    }
    for (const cancel of pending.cancels) {
      if (this.interrupted.has(cancel.runId)) continue;
      this.interrupted.add(cancel.runId);
      starts.push(
        this.options.threads
          .interrupt(cancel.threadId, "Canceled in Office.")
          .catch((error: unknown) => {
            this.interrupted.delete(cancel.runId);
            this.log(`stopping ${cancel.threadId} failed: ${String(error)}`);
          }),
      );
    }
    await Promise.all(starts);
    await Promise.all([...this.watches.values()].map((watch) => this.report(watch)));
    for (const [key, watch] of this.watches) if (watch.finished) this.watches.delete(key);
  }

  /** Runs `tick` every `intervalMs` until `signal` aborts. A failed pass is logged and the next one runs. */
  async run(signal: AbortSignal, intervalMs = 2_000): Promise<void> {
    while (!signal.aborted) {
      await this.tick().catch((error: unknown) => this.log(`pass failed: ${String(error)}`));
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private watch(bindingId: string, threadId: string, providerTurnId: string): void {
    if (this.watches.has(providerTurnId)) return;
    this.watches.set(providerTurnId, {
      bindingId,
      threadId,
      providerTurnId,
      runIds: new Set([providerTurnId]),
      cursor: undefined,
      sent: new Map(),
      lastAnswerKey: undefined,
      finished: false,
    });
  }

  /** Claims a queued turn, sends it to T3, and tells Office T3 took it. */
  private async start(ref: WorkRef, kind: Claim["kind"]): Promise<void> {
    if (this.starting.has(ref.runId)) return;
    this.starting.add(ref.runId);
    let claim: Claim | null = null;
    let started: { threadId: string; runId: string };
    try {
      claim = await this.options.office.claimWork(ref, kind, this.options.environmentId);
      if (claim === null) return;
      started = await this.send(claim);
    } catch (error) {
      this.log(`starting ${ref.runId} failed: ${String(error)}`);
      if (claim !== null) await this.reportFailure(claim, error);
      this.starting.delete(ref.runId);
      return;
    }
    // T3 has the turn. If Office misses this, it offers the run again and the
    // same request id returns the same T3 run, so it is never sent twice.
    try {
      const outcome = await this.post([
        {
          version: 2,
          kind: "accepted",
          eventId: `accepted:${claim.runId}:${started.runId}`,
          bindingId: claim.bindingId,
          agentId: started.threadId,
          providerTurnId: started.runId,
          runId: claim.runId,
          receiptId: claim.receiptId,
          timelineStartSeq: 0,
          startedAt: this.now(),
          environmentId: this.options.environmentId,
          modelSelection: claim.modelSelection ?? this.options.defaultModel,
        },
      ]);
      this.log(`${claim.runId} is T3 run ${started.runId} in ${started.threadId} (${outcome}).`);
      this.watch(claim.bindingId, started.threadId, started.runId);
    } catch (error) {
      this.log(
        `telling Office ${ref.runId} started failed; it will be offered again: ${String(error)}`,
      );
    } finally {
      this.starting.delete(ref.runId);
    }
  }

  private async reportFailure(claim: Claim, error: unknown): Promise<void> {
    try {
      const outcome = await this.options.office.reportPreDispatchFailure({
        runId: claim.runId,
        kind: claim.kind,
        attempt: claim.attempt,
        environmentId: this.options.environmentId,
        errorCode:
          claim.attempt >= MAX_ATTEMPTS
            ? "AGENT_PRE_DISPATCH_RETRY_EXHAUSTED"
            : "AGENT_PRE_DISPATCH_RETRY",
        errorMessage: String(error).slice(0, 1_000),
        terminal: claim.attempt >= MAX_ATTEMPTS,
      });
      this.log(`${claim.runId} attempt ${claim.attempt}: ${outcome}.`);
    } catch (reportError) {
      this.log(`reporting ${claim.runId} failed: ${String(reportError)}`);
    }
  }

  /** Starts the T3 thread, or sends to it. The request id makes a retry return the same run. */
  private async send(claim: Claim): Promise<{ threadId: string; runId: string }> {
    const fetchFile = this.options.fetchFile ?? fetchBytes;
    const priorContext = claim.initialContext
      ? new TextDecoder().decode(await fetchFile(claim.initialContext.downloadUrl))
      : undefined;
    const files: ReadonlyArray<OfficeFile> = [
      ...(claim.initialContext?.files ?? []),
      ...claim.message.files,
    ];
    const imported = await this.options.threads.importFiles(
      files.map((file) => ({
        name: file.filename,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        fetch: () => fetchFile(file.downloadUrl),
      })),
    );
    const skipped = imported.skipped.map((each) => `- ${each.name}: ${each.reason}`);
    const text = [
      formatRequest(claim, priorContext),
      skipped.length > 0 ? `These files couldn't be attached:\n${skipped.join("\n")}` : "",
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    const requestId = `office:${claim.receiptId}:${claim.commandGeneration ?? 0}`;
    const modelSelection = toModelSelection(claim.modelSelection);
    if (claim.kind === "dispatch" && claim.threadId !== undefined) {
      const sent = await this.options.threads.send({
        threadId: claim.threadId,
        text,
        attachments: imported.attachments,
        requestId,
      });
      return { threadId: claim.threadId, runId: sent.runId };
    }
    const launched = await this.options.threads.start({
      projectId: this.options.projectId,
      title: claim.title?.trim() || "Office chat",
      text,
      attachments: imported.attachments,
      requestId,
      worktreeFrom: claim.workspaceMode === "local" ? undefined : this.options.worktreeFrom,
      modelSelection,
    });
    const runId = launched.runId ?? (await this.latestRun(launched.threadId));
    return { threadId: launched.threadId, runId };
  }

  /** A launch that queued its message reports no run yet; T3 starts one in moments. */
  private async latestRun(threadId: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const shape = await this.options.threads.shape(threadId);
      if (shape.latestRun !== undefined) return shape.latestRun.runId;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`T3 started no run in ${threadId}.`);
  }

  /** Sends the run's new and changed items, then its end once T3 says it's over. */
  private async report(watch: Watch): Promise<void> {
    try {
      const read = await this.options.threads.activity(watch.threadId, watch.cursor);
      const mine = read.items.filter((item) => item.runId !== null && watch.runIds.has(item.runId));
      const entries: Array<TimelineEntry> = [];
      for (const item of mine) {
        const entry = await this.entryFor(watch, item);
        if (entry === undefined) continue;
        if ((watch.sent.get(entry.itemKey) ?? -1) >= entry.seqEnd) continue;
        entries.push(entry);
        if (item.type === "assistant_message") watch.lastAnswerKey = item.itemId;
      }
      await this.postEntries(watch, entries);
      const stillOpen = mine.filter((item) => isOpen(item.status));
      watch.cursor =
        stillOpen.length > 0
          ? Math.min(...stillOpen.map((item) => item.position)) - 1
          : Math.max(watch.cursor ?? -1, read.lastPosition);

      const latest = [...watch.runIds].at(-1)!;
      const run = await this.options.threads.waitForRun(watch.threadId, latest, WAIT_SLICE_MS);
      if (!watch.runIds.has(run.runId)) {
        // T3 restarted the run as a new one; its items belong to this turn too.
        watch.runIds.add(run.runId);
        return;
      }
      if (!TERMINAL_STATUSES.has(run.status)) return;
      // Read once more, so the final message is sent before the end.
      const last = await this.options.threads.activity(watch.threadId, watch.cursor);
      const tail: Array<TimelineEntry> = [];
      for (const item of last.items.filter(
        (each) => each.runId !== null && watch.runIds.has(each.runId),
      )) {
        const entry = await this.entryFor(watch, item);
        if (entry === undefined || (watch.sent.get(entry.itemKey) ?? -1) >= entry.seqEnd) continue;
        tail.push(entry);
        if (item.type === "assistant_message") watch.lastAnswerKey = item.itemId;
      }
      await this.postEntries(watch, tail);
      await this.finish(watch, run.status);
    } catch (error) {
      this.log(`reading ${watch.threadId} failed: ${String(error)}`);
    }
  }

  private async entryFor(watch: Watch, item: ActivityItem): Promise<TimelineEntry | undefined> {
    if (item.type !== "assistant_message" || isOpen(item.status)) return timelineEntry(item);
    const text =
      item.textTruncated === true
        ? await this.options.threads.itemText(watch.threadId, item.itemId)
        : (item.text ?? "");
    return timelineEntry(item, text);
  }

  private async postEntries(watch: Watch, entries: ReadonlyArray<TimelineEntry>): Promise<void> {
    const events = entries.map((entry) => ({
      version: 2,
      kind: "timeline",
      eventId: `timeline:${entry.itemKey}:${entry.seqEnd}`,
      bindingId: watch.bindingId,
      agentId: watch.threadId,
      providerTurnId: watch.providerTurnId,
      itemKey: entry.itemKey,
      seqStart: entry.seqStart,
      seqEnd: entry.seqEnd,
      occurredAt: this.now(),
      itemDigest: entry.digest,
      item: entry.item,
    }));
    await this.post(events);
    // Whatever Office said, these are done: an event it refused would fail again.
    for (const entry of entries) watch.sent.set(entry.itemKey, entry.seqEnd);
  }

  private async finish(watch: Watch, status: RunStatus): Promise<void> {
    const common = {
      version: 2,
      bindingId: watch.bindingId,
      agentId: watch.threadId,
      providerTurnId: watch.providerTurnId,
      eventId: `end:${watch.providerTurnId}`,
    };
    const event =
      status === "completed"
        ? {
            ...common,
            kind: "completed",
            finalItemKey: watch.lastAnswerKey ?? "",
            completedAt: this.now(),
          }
        : status === "interrupted" || status === "cancelled"
          ? { ...common, kind: "canceled", errorCode: "T3_RUN_CANCELED", completedAt: this.now() }
          : {
              ...common,
              kind: "failed",
              errorCode: "T3_RUN_FAILED",
              errorMessage: `The T3 run ended ${status}.`,
              completedAt: this.now(),
            };
    const outcome = await this.post([event]);
    this.log(`${watch.providerTurnId} ended ${status} (${outcome}).`);
    watch.finished = true;
  }

  /**
   * Posts events in batches. A batch Office refuses is posted again one event
   * at a time, so one bad event can't hold back the others; that one is logged.
   */
  private async post(events: ReadonlyArray<Record<string, unknown>>): Promise<string> {
    const outcomes: Array<string> = [];
    for (let index = 0; index < events.length; index += EVENT_BATCH) {
      const batch = events.slice(index, index + EVENT_BATCH);
      try {
        outcomes.push(...(await this.options.office.postEvents(batch)).map((each) => each.outcome));
      } catch (error) {
        // Office unreachable: throw, so nothing is marked sent and the next pass tries again.
        if (!(error instanceof OfficeConvexError)) throw error;
        if (batch.length === 1) {
          this.log(`Office refused ${String(batch[0]!.eventId)}: ${String(error)}`);
          outcomes.push("refused");
          continue;
        }
        for (const event of batch) outcomes.push(await this.post([event]));
      }
    }
    return outcomes.join(", ");
  }
}

/** Office's model selection as T3 takes it; none when Office names no model. */
function toModelSelection(selection: OfficeModelSelection | undefined): ModelSelection | undefined {
  if (selection?.model === undefined) return undefined;
  const options = selection.options as ModelSelection["options"] | undefined;
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(options === undefined ? {} : { options }),
  };
}
