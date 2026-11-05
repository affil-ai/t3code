// @effect-diagnostics globalTimers:off -- A plain Node app; it does not use Effect.
/**
 * Starts the Linear adapter without holding up the shared `Chat`: Chat starts
 * every adapter together and fails if one does, so Linear's token fetch runs
 * in the background and retries until it works. Slack and iMessage never wait on it.
 */
import type { ChatInstance } from "chat";

/** Waits between tries: 15 s, doubling, at most 10 minutes, for as long as the bridge runs. */
const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 10 * 60_000;

export interface BackgroundStart {
  /** True once the adapter has its token and knows its own Linear user. */
  readonly ready: () => boolean;
  /** The latest try, for tests to wait on. */
  readonly latest: () => Promise<void>;
  /** Stops retrying, such as at shutdown. */
  readonly stop: () => void;
}

export function startInBackground(
  adapter: {
    initialize: (chat: ChatInstance) => Promise<void>;
    readonly botUserId?: string | undefined;
  },
  options: {
    readonly log: (line: string) => void;
    /** Tests run retries themselves. */
    readonly schedule?: (ms: number, run: () => void) => void;
  },
): BackgroundStart {
  const initialize = adapter.initialize.bind(adapter);
  let ready = false;
  let latest: Promise<void> = Promise.resolve();
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  const schedule =
    options.schedule ??
    ((ms: number, run: () => void) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timer.unref();
      timers.add(timer);
    });

  const attempt = async (chat: ChatInstance, tries: number): Promise<void> => {
    if (stopped) return;
    try {
      await initialize(chat);
      // The adapter only warns when it can't look itself up, and then ignores every new session.
      if (!adapter.botUserId) throw new Error("Linear didn't say which user the app is.");
      ready = true;
      options.log(`Linear: connected${tries > 1 ? ` after ${tries} tries` : ""}.`);
    } catch (error) {
      const delay = Math.min(FIRST_RETRY_MS * 2 ** (tries - 1), MAX_RETRY_MS);
      options.log(
        `Linear: starting failed (try ${tries}); Slack and iMessage keep running, retrying in ${delay / 1000} s: ${error instanceof Error ? error.message : String(error)}`,
      );
      schedule(delay, () => {
        latest = attempt(chat, tries + 1);
      });
    }
  };

  adapter.initialize = async (chat) => {
    latest = attempt(chat, 1);
  };
  return {
    ready: () => ready,
    latest: () => latest,
    stop: () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
