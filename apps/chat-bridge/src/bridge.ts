// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- A plain Node app; it does not use Effect.
/**
 * The T3 side of the bridge. It knows nothing about Slack: the Slack host
 * hands it normalized inbound events, and it posts replies through the
 * `post` callback. It decides who may start work, where a Slack thread's
 * work goes, and which run answers which Slack thread.
 */
import * as NodeCrypto from "node:crypto";

import type { BridgeStore, OwedReply } from "./store.ts";
import {
  type Delivery,
  type FollowUpMode,
  type ImportedFiles,
  type InboundFile,
  type RunStatus,
  TERMINAL_STATUSES,
  type T3Threads,
} from "./threads.ts";

export interface ChatAuthor {
  readonly userId: string;
  readonly userName: string;
  readonly fullName: string;
}

/** Someone the message mentions, other than the bot. */
export interface MentionedUser {
  readonly userId: string;
  readonly name: string;
}

/** One Slack message addressed to the bot, after the host has dropped its own and other bots' messages. */
export interface InboundEvent {
  /** Unique per Slack message, so a redelivery cannot start a second turn. */
  readonly eventId: string;
  /** The Chat SDK thread id, such as `slack:C0123:1700000000.000100`. */
  readonly chatThreadKey: string;
  readonly channelId: string;
  /** The message's Slack `ts`, which `chat_react` takes. */
  readonly messageId: string;
  /** A mention outside a bound thread starts one; anything in a bound thread follows up. */
  readonly kind: "mention" | "follow_up";
  readonly author: ChatAuthor;
  readonly text: string;
  readonly files: ReadonlyArray<InboundFile>;
  readonly mentions: ReadonlyArray<MentionedUser>;
}

export type InboundOutcome =
  | { readonly type: "started"; readonly threadId: string }
  | { readonly type: "followed_up"; readonly threadId: string; readonly delivery: Delivery }
  | {
      readonly type: "ignored";
      readonly reason: "duplicate" | "not_allowed" | "unmapped_channel" | "unbound_thread";
    };

export interface BridgeSettings {
  readonly channelProjects: ReadonlyArray<{
    readonly channelId: string;
    readonly projectId: string;
  }>;
  readonly allowedUserIds: ReadonlyArray<string>;
  readonly followUpMode: FollowUpMode;
}

export interface Reply {
  readonly chatThreadKey: string;
  readonly text: string;
}

const TERMINAL_TEXT: Partial<Record<RunStatus, string>> = {
  failed: "The run failed. Open the thread in T3 Code for details.",
  cancelled: "The run was stopped.",
  interrupted: "The run was stopped.",
  rolled_back: "The run was rolled back.",
};

const TITLE_LIMIT = 80;
/** One `t3_thread_wait` call; the watcher calls again until the run ends. */
const WAIT_SLICE_MS = 10 * 60_000;
const RETRY_DELAY_MS = 15_000;

/** Tells the agent how its answer reaches Slack, once per thread. */
function firstTurnNote(chatKey: string): string {
  return [
    "Your final message in each run is posted to this Slack thread.",
    "If a message needs no reply, end the run without a final message and nothing is posted.",
    "To mention someone there, write <@USERID>, such as <@U0123ABCD>.",
    `To send files, call the chat_post tool with chatKey "${chatKey}" and their paths in your workspace.`,
    `To react to a message, call the chat_react tool with chatKey "${chatKey}", the message id and an emoji name.`,
  ].join(" ");
}

function turnText(
  event: InboundEvent,
  skipped: ImportedFiles["skipped"],
  chatKey: string,
  first: boolean,
): string {
  const lines = [
    `Slack message ${event.messageId} from ${event.author.fullName || event.author.userName} (<@${event.author.userId}>):`,
    "",
    event.text,
  ];
  if (event.mentions.length > 0) {
    const people = event.mentions.map((user) => `${user.name} (<@${user.userId}>)`);
    lines.push("", `Mentioned: ${people.join(", ")}`);
  }
  if (skipped.length > 0) {
    const files = skipped.map((file) => `${file.name} (${file.reason})`);
    lines.push("", `Attached in Slack but not imported: ${files.join(", ")}`);
  }
  lines.push("", first ? firstTurnNote(chatKey) : `(chat key: ${chatKey})`);
  return lines.join("\n");
}

function threadTitle(text: string): string {
  const firstLine = text.trim().split("\n", 1)[0] ?? "";
  if (firstLine === "") return "Slack request";
  return firstLine.length > TITLE_LIMIT ? `${firstLine.slice(0, TITLE_LIMIT - 1)}…` : firstLine;
}

/** T3 retry keys are at most 256 characters. */
const requestId = (eventId: string) => `chat-bridge:${eventId}`.slice(0, 256);

export class Bridge {
  /** Runs with a watcher, so a run is watched once. */
  private readonly watching = new Map<string, Promise<void>>();
  private stopped = false;
  private readonly store: BridgeStore;
  private readonly threads: T3Threads;
  private readonly settings: BridgeSettings;
  private readonly post: (reply: Reply) => Promise<void>;
  private readonly log: (line: string) => void;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: {
    readonly store: BridgeStore;
    readonly threads: T3Threads;
    readonly settings: BridgeSettings;
    readonly post: (reply: Reply) => Promise<void>;
    readonly log?: (line: string) => void;
    /** Tests skip the wait between retries. */
    readonly sleep?: (ms: number) => Promise<void>;
  }) {
    this.store = options.store;
    this.threads = options.threads;
    this.settings = options.settings;
    this.post = options.post;
    this.log = options.log ?? (() => {});
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async receive(event: InboundEvent): Promise<InboundOutcome> {
    if (!this.settings.allowedUserIds.includes(event.author.userId)) {
      return { type: "ignored", reason: "not_allowed" };
    }
    if (this.store.isHandled(event.eventId)) return { type: "ignored", reason: "duplicate" };

    const binding = this.store.binding(event.chatThreadKey);
    if (binding !== undefined) {
      const imported = await this.threads.importFiles(event.files);
      const sent = await this.threads.send({
        threadId: binding.threadId,
        text: turnText(event, imported.skipped, binding.chatKey, false),
        attachments: imported.attachments,
        mode: this.settings.followUpMode,
        requestId: requestId(event.eventId),
      });
      this.store.markHandled(event.eventId);
      // A steered message can join a run someone started in T3; its answer is owed here too.
      this.owe({
        runId: sent.runId,
        threadId: binding.threadId,
        chatThreadKey: binding.chatThreadKey,
      });
      return { type: "followed_up", threadId: binding.threadId, delivery: sent.delivery };
    }
    if (event.kind === "follow_up") return { type: "ignored", reason: "unbound_thread" };

    const mapping = this.settings.channelProjects.find(
      (entry) => entry.channelId === event.channelId,
    );
    if (mapping === undefined) return { type: "ignored", reason: "unmapped_channel" };
    const chatKey = NodeCrypto.randomBytes(16).toString("hex");
    const imported = await this.threads.importFiles(event.files);
    // The retry key makes a relaunch after a crash return the same thread.
    const started = await this.threads.start({
      projectId: mapping.projectId,
      title: threadTitle(event.text),
      text: turnText(event, imported.skipped, chatKey, true),
      attachments: imported.attachments,
      requestId: requestId(event.eventId),
    });
    this.store.insertBinding({
      chatThreadKey: event.chatThreadKey,
      channelId: event.channelId,
      projectId: mapping.projectId,
      threadId: started.threadId,
      chatKey,
      createdByUserId: event.author.userId,
    });
    this.store.markHandled(event.eventId);
    if (started.runId !== null) {
      this.owe({
        runId: started.runId,
        threadId: started.threadId,
        chatThreadKey: event.chatThreadKey,
      });
    }
    return { type: "started", threadId: started.threadId };
  }

  /** Watches every reply still owed, such as those left by a restart. */
  resume(): void {
    for (const reply of this.store.pendingReplies()) this.watch(reply);
  }

  /** Resolves once every reply being watched has been posted or given up. */
  async idle(): Promise<void> {
    while (this.watching.size > 0) await Promise.allSettled(this.watching.values());
  }

  stop(): void {
    this.stopped = true;
  }

  private owe(reply: OwedReply): void {
    this.store.oweReply(reply);
    this.watch(reply);
  }

  private watch(reply: OwedReply): void {
    if (this.watching.has(reply.runId)) return;
    this.watching.set(
      reply.runId,
      this.watchUntilAnswered(reply).finally(() => this.watching.delete(reply.runId)),
    );
  }

  private async watchUntilAnswered(reply: OwedReply): Promise<void> {
    while (!this.stopped) {
      try {
        const waited = await this.threads.waitForRun(reply.threadId, reply.runId, WAIT_SLICE_MS);
        if (waited.timedOut || !TERMINAL_STATUSES.has(waited.status)) continue;
        await this.answer(reply, waited.runId, waited.status);
        return;
      } catch (error) {
        this.log(`Waiting for ${reply.runId} failed; retrying: ${String(error)}`);
        await this.sleep(RETRY_DELAY_MS);
      }
    }
  }

  /** Posts the run's answer once. A completed run with no final message chose to stay quiet. */
  private async answer(reply: OwedReply, finalRunId: string, status: RunStatus): Promise<void> {
    if (!this.store.claimReply(reply)) return;
    // A restart continues in a new run; claim it too, so a later message that joins it does not answer twice.
    if (finalRunId !== reply.runId && !this.store.claimReply({ ...reply, runId: finalRunId }))
      return;
    try {
      const text =
        status === "completed"
          ? await this.threads.finalAnswer(reply.threadId, finalRunId)
          : TERMINAL_TEXT[status];
      if (text !== undefined) await this.post({ chatThreadKey: reply.chatThreadKey, text });
    } catch (error) {
      this.store.releaseReply(reply.runId);
      if (finalRunId !== reply.runId) this.store.releaseReply(finalRunId);
      throw error;
    }
  }
}
