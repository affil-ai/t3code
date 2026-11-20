// @effect-diagnostics globalTimers:off -- A plain Node app; it does not use Effect.
/**
 * Reports each T3 thread's Slack thread or Linear issue to Office (`chatBridge:bindThreadChannels`):
 * binding rows saved since a `bridge_meta` cursor, so the first start backfills them all. Office is
 * idempotent, and a failure is logged without the conversation and retried, never failing a chat.
 */
import type { Binding } from "../store.ts";

export const THREAD_CHANNELS_CURSOR_KEY = "office_thread_channels_reported_to";
/** Office's `MAX_BINDINGS_PER_CALL`. */
const BATCH = 200;
const RETRY_MS = 60_000;

const SLACK_KEY = /^slack:([CDG][A-Z0-9]{2,30}):(\d{9,11}\.\d{1,6})$/;
const LINEAR_KEY = /^linear:([^:\s]+)$/;
const LINEAR_URL = /^https:\/\/linear\.app\/[^/\s]+\/issue\/[A-Za-z0-9]+-\d+(?:[/?#]\S*)?$/;

/** One entry of `chatBridge:bindThreadChannels`'s `bindings`. */
export type ThreadChannelBinding = {
  environmentId: string;
  threadId: string;
  slack?: { channelId: string; threadTs: string };
  linear?: { issueUrl: string };
  boundAt?: number;
};

export interface ThreadChannelStore {
  bindingsSavedSince(since: number): ReadonlyArray<Binding & { readonly createdAt: number }>;
  meta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

export interface ThreadChannelReporterOptions {
  readonly store: ThreadChannelStore;
  readonly send: (bindings: ReadonlyArray<ThreadChannelBinding>) => Promise<unknown>;
  /** The T3 environment, as in a task's `t3-thread://v2/<environmentId>/<threadId>` owner. */
  readonly environmentId: string;
  /** A Linear issue's URL from its id; Linear bindings are left out without it. */
  readonly linearIssueUrl?: ((issueId: string) => Promise<string | undefined>) | undefined;
  readonly log: (line: string) => void;
  readonly retryMs?: number;
  /** Defaults to `setTimeout`; tests pass their own. */
  readonly timer?: Timer;
}

export interface Timer {
  set(run: () => unknown, ms: number): { cancel(): void };
}

const realTimer: Timer = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

export interface ThreadChannelReporter {
  /** Reports what's new soon, outside the caller's transaction. Never throws. */
  notify(): void;
  /** Reports everything since the cursor. Resolves once done or failed; never rejects. */
  sync(): Promise<{ readonly sent: number } | { readonly failed: true }>;
  stop(): void;
}

export function createThreadChannelReporter(
  options: ThreadChannelReporterOptions,
): ThreadChannelReporter {
  let running: Promise<{ readonly sent: number } | { readonly failed: true }> | undefined;
  let again = false;
  let stopped = false;
  let pending: { cancel(): void } | undefined;
  const timer = options.timer ?? realTimer;

  const schedule = (ms: number) => {
    if (stopped || pending !== undefined) return;
    pending = timer.set(() => {
      pending = undefined;
      return sync();
    }, ms);
  };

  const toChannel = async (binding: Binding & { readonly createdAt: number }) => {
    const base = {
      environmentId: options.environmentId,
      threadId: binding.threadId,
      boundAt: binding.createdAt,
    };
    const slack = SLACK_KEY.exec(binding.chatThreadKey);
    if (slack) return { ...base, slack: { channelId: slack[1]!, threadTs: slack[2]! } };
    const linear = LINEAR_KEY.exec(binding.chatThreadKey);
    if (linear && options.linearIssueUrl) {
      const issueUrl = await options.linearIssueUrl(linear[1]!).catch(() => undefined);
      if (issueUrl && LINEAR_URL.test(issueUrl)) return { ...base, linear: { issueUrl } };
      options.log(`Office thread channels: no Linear issue URL for thread ${binding.threadId}.`);
    }
    // iMessage and Office chats have no channel Office links to.
    return undefined;
  };

  const once = async (): Promise<{ readonly sent: number } | { readonly failed: true }> => {
    const cursor = Number(options.store.meta(THREAD_CHANNELS_CURSOR_KEY) ?? 0) || 0;
    // `>=`: a binding saved in the same millisecond as the last one sent is not missed.
    const rows = options.store.bindingsSavedSince(cursor);
    if (rows.length === 0) return { sent: 0 };
    const bindings: ThreadChannelBinding[] = [];
    for (const row of rows) {
      const binding = await toChannel(row);
      if (binding) bindings.push(binding);
    }
    try {
      for (let index = 0; index < bindings.length; index += BATCH) {
        await options.send(bindings.slice(index, index + BATCH));
      }
    } catch {
      options.log(
        `Office thread channels: reporting ${bindings.length} binding(s) failed; retrying later.`,
      );
      return { failed: true };
    }
    const latest = Math.max(...rows.map((row) => row.createdAt));
    if (latest > cursor) options.store.setMeta(THREAD_CHANNELS_CURSOR_KEY, String(latest));
    return { sent: bindings.length };
  };

  const sync = (): Promise<{ readonly sent: number } | { readonly failed: true }> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let result: { readonly sent: number } | { readonly failed: true };
      do {
        again = false;
        result = await once().catch(() => {
          options.log("Office thread channels: reading bindings failed; retrying later.");
          return { failed: true } as const;
        });
      } while (again && !("failed" in result));
      if ("failed" in result) schedule(options.retryMs ?? RETRY_MS);
      return result;
    })().finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    notify: () => schedule(0),
    sync,
    stop: () => {
      stopped = true;
      pending?.cancel();
      pending = undefined;
    },
  };
}
