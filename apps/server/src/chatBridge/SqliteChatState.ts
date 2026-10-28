/**
 * The Chat SDK's `StateAdapter` on T3's SQLite database: thread
 * subscriptions, per-thread locks, the dedupe cache and the SDK's message
 * queues survive a server restart without Redis.
 *
 * The SDK calls this with Promises, so each method runs one Effect against
 * the captured SqlClient. Multi-row writes run in a transaction; lock and
 * set-if-absent are single upserts, so they stay atomic on their own.
 */
import type { Lock, QueueEntry, StateAdapter } from "chat";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureSchema } from "./schema.ts";

const encode = (value: unknown) => JSON.stringify(value);
const decode = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export interface SqliteChatStateOptions {
  /** Unix milliseconds. Tests pass a controllable clock. */
  readonly now: () => number;
  readonly randomToken: Effect.Effect<string>;
}

export const make = Effect.fn("SqliteChatState.make")(function* (options: SqliteChatStateOptions) {
  const sql = yield* SqlClient.SqlClient;
  const context = yield* Effect.context<SqlClient.SqlClient>();
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromiseWith(context)(effect);
  const runVoid = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    run(Effect.asVoid(effect));
  const { now } = options;

  const adapter: StateAdapter = {
    connect: () => run(ensureSchema),
    disconnect: async () => {},

    subscribe: (threadId) =>
      runVoid(
        sql`INSERT OR IGNORE INTO chat_bridge_state_subscription (thread_id) VALUES (${threadId})`,
      ),
    unsubscribe: (threadId) =>
      runVoid(sql`DELETE FROM chat_bridge_state_subscription WHERE thread_id = ${threadId}`),
    isSubscribed: (threadId) =>
      run(
        sql`SELECT 1 FROM chat_bridge_state_subscription WHERE thread_id = ${threadId}`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
      ),

    acquireLock: (threadId, ttlMs) =>
      run(
        Effect.gen(function* () {
          const token = yield* options.randomToken;
          const [row] = yield* sql<{ token: string; expires_at: number }>`
            INSERT INTO chat_bridge_state_lock (thread_id, token, expires_at)
            VALUES (${threadId}, ${token}, ${now() + ttlMs})
            ON CONFLICT (thread_id) DO UPDATE
              SET token = excluded.token, expires_at = excluded.expires_at
              WHERE chat_bridge_state_lock.expires_at <= ${now()}
            RETURNING token, expires_at`;
          return row === undefined
            ? null
            : ({ threadId, token: row.token, expiresAt: row.expires_at } satisfies Lock);
        }),
      ),
    extendLock: (lock, ttlMs) =>
      run(
        sql`
          UPDATE chat_bridge_state_lock SET expires_at = ${now() + ttlMs}
          WHERE thread_id = ${lock.threadId} AND token = ${lock.token} AND expires_at > ${now()}
          RETURNING thread_id`.pipe(Effect.map((rows) => rows.length > 0)),
      ),
    releaseLock: (lock) =>
      runVoid(
        sql`DELETE FROM chat_bridge_state_lock WHERE thread_id = ${lock.threadId} AND token = ${lock.token}`,
      ),
    forceReleaseLock: (threadId) =>
      runVoid(sql`DELETE FROM chat_bridge_state_lock WHERE thread_id = ${threadId}`),

    get: <T>(key: string) =>
      run(
        Effect.gen(function* () {
          const [row] = yield* sql<{ value: string; expires_at: number | null }>`
            SELECT value, expires_at FROM chat_bridge_state_cache WHERE cache_key = ${key}`;
          if (row === undefined) return null;
          if (row.expires_at !== null && row.expires_at <= now()) {
            yield* sql`DELETE FROM chat_bridge_state_cache WHERE cache_key = ${key} AND expires_at <= ${now()}`;
            return null;
          }
          return decode(row.value) as T;
        }),
      ),
    set: (key, value, ttlMs) =>
      runVoid(sql`
        INSERT INTO chat_bridge_state_cache (cache_key, value, expires_at)
        VALUES (${key}, ${encode(value)}, ${ttlMs ? now() + ttlMs : null})
        ON CONFLICT (cache_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`),
    setIfNotExists: (key, value, ttlMs) =>
      run(
        sql`
          INSERT INTO chat_bridge_state_cache (cache_key, value, expires_at)
          VALUES (${key}, ${encode(value)}, ${ttlMs ? now() + ttlMs : null})
          ON CONFLICT (cache_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
            WHERE chat_bridge_state_cache.expires_at IS NOT NULL
              AND chat_bridge_state_cache.expires_at <= ${now()}
          RETURNING cache_key`.pipe(Effect.map((rows) => rows.length > 0)),
      ),
    delete: (key) => runVoid(sql`DELETE FROM chat_bridge_state_cache WHERE cache_key = ${key}`),

    appendToList: (key, value, listOptions) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            const expiresAt = listOptions?.ttlMs ? now() + listOptions.ttlMs : null;
            yield* sql`INSERT INTO chat_bridge_state_list (list_key, value, expires_at)
              VALUES (${key}, ${encode(value)}, ${expiresAt})`;
            if (listOptions?.maxLength) {
              yield* sql`DELETE FROM chat_bridge_state_list WHERE list_key = ${key} AND seq NOT IN (
                SELECT seq FROM chat_bridge_state_list WHERE list_key = ${key}
                ORDER BY seq DESC LIMIT ${listOptions.maxLength})`;
            }
            // The TTL covers the whole list, as in the SDK's own adapters.
            if (expiresAt !== null) {
              yield* sql`UPDATE chat_bridge_state_list SET expires_at = ${expiresAt} WHERE list_key = ${key}`;
            }
          }),
        ),
      ),
    getList: <T>(key: string) =>
      run(
        sql<{ value: string }>`
          SELECT value FROM chat_bridge_state_list
          WHERE list_key = ${key} AND (expires_at IS NULL OR expires_at > ${now()})
          ORDER BY seq ASC`.pipe(Effect.map((rows) => rows.map((row) => decode(row.value) as T))),
      ),

    enqueue: (threadId, entry, maxSize) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM chat_bridge_state_queue WHERE thread_id = ${threadId} AND expires_at <= ${now()}`;
            yield* sql`INSERT INTO chat_bridge_state_queue (thread_id, value, expires_at)
              VALUES (${threadId}, ${encode(entry)}, ${entry.expiresAt})`;
            if (maxSize > 0) {
              yield* sql`DELETE FROM chat_bridge_state_queue WHERE thread_id = ${threadId} AND seq NOT IN (
                SELECT seq FROM chat_bridge_state_queue WHERE thread_id = ${threadId}
                ORDER BY seq DESC LIMIT ${maxSize})`;
            }
            const [row] = yield* sql<{ depth: number }>`
              SELECT count(*) AS depth FROM chat_bridge_state_queue WHERE thread_id = ${threadId}`;
            return row?.depth ?? 0;
          }),
        ),
      ),
    dequeue: (threadId) =>
      run(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM chat_bridge_state_queue WHERE thread_id = ${threadId} AND expires_at <= ${now()}`;
            const [row] = yield* sql<{ seq: number; value: string }>`
              SELECT seq, value FROM chat_bridge_state_queue WHERE thread_id = ${threadId}
              ORDER BY seq ASC LIMIT 1`;
            if (row === undefined) return null;
            yield* sql`DELETE FROM chat_bridge_state_queue WHERE seq = ${row.seq}`;
            return decode(row.value) as QueueEntry;
          }),
        ),
      ),
    queueDepth: (threadId) =>
      run(
        sql<{ depth: number }>`
          SELECT count(*) AS depth FROM chat_bridge_state_queue
          WHERE thread_id = ${threadId} AND expires_at > ${now()}`.pipe(
          Effect.map(([row]) => row?.depth ?? 0),
        ),
      ),
  };
  return adapter;
});
