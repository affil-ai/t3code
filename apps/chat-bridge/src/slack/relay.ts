// @effect-diagnostics globalTimers:off -- A plain Node app; it does not use Effect.
/**
 * Slack requests Office verified and stored, read over the token-authenticated
 * Office connection, replayed through the Slack adapter's webhook handler, and
 * marked delivered once handled.
 */

/** One request Slack sent Office, as `chatBridge:slackInbox` returns it. */
export interface SlackInboxRow {
  readonly id: string;
  readonly kind: "event" | "interaction";
  /** The exact bytes Slack sent. */
  readonly rawBody: string;
  readonly contentType: string;
  readonly retryNum: number;
}

/** Office's side of the relay; `OfficeClient` in production, a fake in tests. */
export interface SlackRelaySource {
  /** Calls `onRows` with the undelivered rows, oldest first, now and whenever they change. */
  readonly subscribeSlackInbox: (
    onRows: (rows: ReadonlyArray<SlackInboxRow>) => void,
    onError: () => void,
  ) => () => void;
  /** Marks rows delivered; marking one twice is fine. */
  readonly slackDelivered: (ids: ReadonlyArray<string>) => Promise<void>;
}

/** What the Chat SDK passes a webhook: background work goes to `waitUntil`. */
export type SlackWebhookHandler = (
  request: Request,
  options: {
    readonly waitUntil: (task: Promise<unknown>) => void;
    readonly propagateHandlerErrors: boolean;
  },
) => Promise<Response>;

/** Accepts the body as given: Office verified Slack's signature before storing it. */
export const relayedWebhookVerifier = (_request: Request, body: string): string => body;

/** The request Slack would have posted, rebuilt from a row. Only the adapter reads it. */
export function relayedRequest(row: SlackInboxRow): Request {
  return new Request("http://127.0.0.1/slack/relay", {
    method: "POST",
    headers: { "content-type": row.contentType, "x-slack-retry-num": String(row.retryNum) },
    body: row.rawBody,
  });
}

/**
 * Hands one row to the Slack webhook handler and waits for everything it
 * started, including work started by that work, such as the stop handler a
 * stopped agent session runs. Throws when the handler refuses the row or any
 * of that work fails.
 */
export async function handleRelayedRow(
  handler: SlackWebhookHandler,
  row: SlackInboxRow,
): Promise<void> {
  const tasks: Array<Promise<unknown>> = [];
  const response = await handler(relayedRequest(row), {
    waitUntil: (task) => {
      tasks.push(task);
    },
    // Rejects the task on a Chat SDK failure, so the row is tried again. The bridge's
    // own handlers catch their errors; their failed sends retry from its inbox instead.
    propagateHandlerErrors: true,
  });
  if (!response.ok) throw new Error(`the Slack handler answered ${response.status}`);
  const failures: Array<unknown> = [];
  while (tasks.length > 0) {
    for (const result of await Promise.allSettled(tasks.splice(0))) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} handler task(s) failed`);
}

export const RELAY_MAX_ATTEMPTS = 3;
/** Rows handled at once, so one slow conversation doesn't hold up the others. */
export const RELAY_CONCURRENCY = 8;
/** A row still running after this counts as a failed try. */
export const RELAY_ROW_TIMEOUT_MS = 120_000;
const RETRY_DELAY_MS = 2_000;
/** Ids remembered after delivery, so a stale snapshot doesn't replay them. */
const SEEN_LIMIT = 2_000;

export interface SlackRelay {
  /** Resolves once the rows seen so far are handled and marked delivered. */
  readonly idle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Consumes the relay, up to `RELAY_CONCURRENCY` rows at once (the bridge core keeps
 * per-conversation order). A row that fails or times out gets `RELAY_MAX_ATTEMPTS`
 * tries, then is logged and marked delivered; rows are only marked after handling.
 */
export function startSlackRelay(options: {
  readonly source: SlackRelaySource;
  readonly handle: (row: SlackInboxRow) => Promise<void>;
  readonly log: (line: string) => void;
  /** Between attempts; tests pass one that resolves at once. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Resolves when a row has run too long; tests pass a controllable one. */
  readonly timeout?: (ms: number) => Promise<void>;
}): SlackRelay {
  const realSleep = (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref();
    });
  const sleep = options.sleep ?? realSleep;
  const timeout = options.timeout ?? realSleep;
  let latest: ReadonlyArray<SlackInboxRow> = [];
  /** Handled (or given up on) in this process, in insertion order. */
  const handled = new Set<string>();
  /** Handled ids whose `slackDelivered` hasn't succeeded yet. */
  const unacked = new Set<string>();
  /** Rows being handled now. */
  const inFlight = new Set<string>();
  /** Row tasks and the delivery call still running, for `idle` and `close`. */
  const active = new Set<Promise<void>>();
  let acking = false;
  let closed = false;

  const track = (task: Promise<void>) => {
    active.add(task);
    void task.finally(() => active.delete(task));
  };

  const remember = (id: string) => {
    handled.add(id);
    unacked.add(id);
    if (handled.size > SEEN_LIMIT) {
      const oldest = handled.values().next().value;
      if (oldest !== undefined) handled.delete(oldest);
    }
  };

  const attempt = async (row: SlackInboxRow) => {
    let timer = false;
    const handling = options.handle(row);
    // A timed-out try keeps running; a retry of the same Slack event is dropped by the bridge's dedupe.
    handling.catch(() => {});
    await Promise.race([
      handling,
      timeout(RELAY_ROW_TIMEOUT_MS).then(() => {
        timer = true;
      }),
    ]);
    if (timer) throw new Error(`still running after ${RELAY_ROW_TIMEOUT_MS / 1000} s`);
  };

  /** Resolves true when handled or given up on, false when the relay closed first. */
  const handleRow = async (row: SlackInboxRow): Promise<boolean> => {
    for (let tries = 1; ; tries++) {
      try {
        await attempt(row);
        return true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        if (tries >= RELAY_MAX_ATTEMPTS) {
          options.log(
            `Slack relay: giving up on ${row.kind} ${row.id} after ${tries} tries (${reason}); marking it delivered.`,
          );
          return true;
        }
        options.log(`Slack relay: ${row.kind} ${row.id} failed (try ${tries}): ${reason}`);
        await sleep(RETRY_DELAY_MS * tries);
        if (closed) return false;
      }
    }
  };

  const ack = () => {
    if (acking || closed || unacked.size === 0) return;
    acking = true;
    const ids = [...unacked];
    track(
      (async () => {
        try {
          await options.source.slackDelivered(ids);
          for (const id of ids) unacked.delete(id);
        } catch {
          options.log(`Slack relay: marking ${ids.length} row(s) delivered failed; retrying.`);
          await sleep(RETRY_DELAY_MS);
        } finally {
          acking = false;
        }
        ack();
      })(),
    );
  };

  const fill = () => {
    for (const row of latest) {
      if (closed || inFlight.size >= RELAY_CONCURRENCY) return;
      if (handled.has(row.id) || inFlight.has(row.id)) continue;
      inFlight.add(row.id);
      track(
        (async () => {
          const done = await handleRow(row);
          inFlight.delete(row.id);
          if (!done) return;
          remember(row.id);
          ack();
          fill();
        })(),
      );
    }
  };

  const unsubscribe = options.source.subscribeSlackInbox(
    (rows) => {
      latest = rows;
      fill();
    },
    () => options.log("Slack relay: inbox subscription failed; waiting for Convex to reconnect."),
  );

  const settled = async () => {
    while (active.size > 0) await Promise.allSettled(active);
  };

  return {
    idle: settled,
    close: async () => {
      closed = true;
      unsubscribe();
      await settled();
    },
  };
}

/**
 * The relay for a Slack transport: none in Socket Mode, where Slack talks to
 * the bridge directly; with `office-relay`, Office's rows replayed through the
 * running `Chat`'s Slack webhook handler.
 */
export function connectSlackRelay(options: {
  readonly transport: "socket" | "office-relay";
  readonly source: SlackRelaySource;
  readonly chat: { readonly webhooks: Readonly<Record<string, SlackWebhookHandler | undefined>> };
  readonly log: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeout?: (ms: number) => Promise<void>;
}): SlackRelay | undefined {
  if (options.transport !== "office-relay") return undefined;
  const handler = options.chat.webhooks.slack;
  if (handler === undefined) throw new Error("The Slack relay needs the Slack adapter.");
  return startSlackRelay({
    source: options.source,
    handle: (row) => handleRelayedRow(handler, row),
    log: options.log,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
  });
}
