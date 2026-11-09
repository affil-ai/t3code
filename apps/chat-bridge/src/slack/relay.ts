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
    // A failure in the Chat SDK then rejects the task, so the row is tried again.
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
const RETRY_DELAY_MS = 2_000;
/** Ids remembered after delivery, so a stale snapshot doesn't replay them. */
const SEEN_LIMIT = 2_000;

export interface SlackRelay {
  /** Resolves once the rows seen so far are handled and marked delivered. */
  readonly idle: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/**
 * Consumes the relay: rows in order, one batch at a time. A row that fails
 * is tried up to `RELAY_MAX_ATTEMPTS` times, then logged and marked delivered
 * anyway, so one bad row can't hold up the rest. Rows waiting when the bridge
 * starts, such as messages sent while it was down, come in the first update.
 */
export function startSlackRelay(options: {
  readonly source: SlackRelaySource;
  readonly handle: (row: SlackInboxRow) => Promise<void>;
  readonly log: (line: string) => void;
  /** Between attempts; tests pass one that resolves at once. */
  readonly sleep?: (ms: number) => Promise<void>;
}): SlackRelay {
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      }));
  let latest: ReadonlyArray<SlackInboxRow> = [];
  /** Handled (or given up on) in this process, in insertion order. */
  const handled = new Set<string>();
  /** Handled ids whose `slackDelivered` hasn't succeeded yet. */
  const unacked = new Set<string>();
  let closed = false;
  let again = false;
  let pumping: Promise<void> | undefined;
  const isClosed = () => closed;

  const remember = (id: string) => {
    handled.add(id);
    unacked.add(id);
    if (handled.size > SEEN_LIMIT) {
      const oldest = handled.values().next().value;
      if (oldest !== undefined) handled.delete(oldest);
    }
  };

  const handleRow = async (row: SlackInboxRow) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await options.handle(row);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        if (attempt >= RELAY_MAX_ATTEMPTS) {
          options.log(
            `Slack relay: giving up on ${row.kind} ${row.id} after ${attempt} tries (${reason}); marking it delivered.`,
          );
          return;
        }
        options.log(`Slack relay: ${row.kind} ${row.id} failed (try ${attempt}): ${reason}`);
        await sleep(RETRY_DELAY_MS * attempt);
        if (closed) throw new Error("The Slack relay closed.", { cause: error });
      }
    }
  };

  const pump = async () => {
    do {
      again = false;
      for (const row of latest.filter((each) => !handled.has(each.id))) {
        if (closed) return;
        try {
          await handleRow(row);
        } catch {
          return;
        }
        remember(row.id);
      }
      if (unacked.size > 0 && !closed) {
        const ids = [...unacked];
        try {
          await options.source.slackDelivered(ids);
          for (const id of ids) unacked.delete(id);
        } catch {
          options.log(`Slack relay: marking ${ids.length} row(s) delivered failed; retrying.`);
          await sleep(RETRY_DELAY_MS);
          again = true;
        }
      }
    } while (again && !isClosed());
  };

  const kick = () => {
    if (pumping !== undefined) {
      again = true;
      return;
    }
    pumping = pump().finally(() => {
      pumping = undefined;
    });
  };

  const unsubscribe = options.source.subscribeSlackInbox(
    (rows) => {
      latest = rows;
      kick();
    },
    () => options.log("Slack relay: inbox subscription failed; waiting for Convex to reconnect."),
  );

  return {
    idle: async () => {
      for (let current = pumping; current !== undefined; current = pumping) await current;
    },
    close: async () => {
      closed = true;
      unsubscribe();
      await pumping;
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
}): SlackRelay | undefined {
  if (options.transport !== "office-relay") return undefined;
  const handler = options.chat.webhooks.slack;
  if (handler === undefined) throw new Error("The Slack relay needs the Slack adapter.");
  return startSlackRelay({
    source: options.source,
    handle: (row) => handleRelayedRow(handler, row),
    log: options.log,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
}
