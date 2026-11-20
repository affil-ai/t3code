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

/** Runs a Linear call, getting a new token and trying once more if Linear says the bridge isn't signed in. */
export type Retry = <T>(run: () => Promise<T>) => Promise<T>;

export const noRetry: Retry = (run) => run();

/**
 * Linear's sign-in errors: the SDK's AuthenticationLinearError, a 401, or the
 * bridge's own download of an upload answered 401.
 */
export function isAuthError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { type, status, message } = error as {
    readonly type?: unknown;
    readonly status?: unknown;
    readonly message?: unknown;
  };
  return (
    type === "AuthenticationError" ||
    status === 401 ||
    (typeof message === "string" &&
      /authentication required|not authenticated|answered 401/i.test(message))
  );
}

/**
 * Linear issues no refresh token and expects a new client-credentials token
 * after a 401; a token can also be revoked early, such as when one is
 * requested with other scopes. Concurrent failures share one refresh.
 */
export function authRetry(refresh: () => Promise<void>, log: (line: string) => void): Retry {
  let refreshing: Promise<void> | undefined;
  const renew = () => {
    refreshing ??= (async () => {
      log("Linear: the token was refused; getting a new one.");
      try {
        await refresh();
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  };
  return async (run) => {
    try {
      return await run();
    } catch (error) {
      if (!isAuthError(error)) throw error;
      await renew();
      return run();
    }
  };
}

/** Wraps the named adapter methods, such as the ones Chat SDK calls to post, with `retry`. */
export function retryMethods(target: object, names: ReadonlyArray<string>, retry: Retry): void {
  const methods = target as Record<string, unknown>;
  for (const name of names) {
    const original = methods[name];
    if (typeof original !== "function") continue;
    const bound = (original as (...args: Array<unknown>) => Promise<unknown>).bind(target);
    methods[name] = (...args: Array<unknown>) => retry(() => bound(...args));
  }
}
