// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * The Chat SDK's `StateAdapter` on the bridge's SQLite file: thread
 * subscriptions, per-thread locks, the dedupe cache and the SDK's message
 * queues survive a restart without Redis. Lock and set-if-absent are single
 * upserts, so they stay atomic; multi-row writes run in a transaction.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import type { Lock, QueueEntry, StateAdapter } from "chat";

const encode = (value: unknown) => JSON.stringify(value);
const decode = (text: unknown): unknown => {
  try {
    return JSON.parse(String(text));
  } catch {
    return text;
  }
};

export interface ChatStateOptions {
  /** Unix milliseconds. Tests pass a controllable clock. */
  readonly now?: () => number;
  readonly randomToken?: () => string;
}

export function createChatState(
  db: NodeSqlite.DatabaseSync,
  options: ChatStateOptions = {},
): StateAdapter {
  const now = options.now ?? Date.now;
  const randomToken = options.randomToken ?? (() => NodeCrypto.randomBytes(16).toString("hex"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_subscription (thread_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS state_lock (
      thread_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS state_cache (
      cache_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS state_list (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      list_key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS state_list_key ON state_list (list_key, seq);
    CREATE TABLE IF NOT EXISTS state_queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS state_queue_thread ON state_queue (thread_id, seq);
  `);

  const transaction = <A>(body: () => A): A => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const count = (sql: string, ...params: Array<string | number>) =>
    Number(db.prepare(sql).get(...params)?.depth ?? 0);

  return {
    connect: async () => {},
    disconnect: async () => {},

    subscribe: async (threadId) => {
      db.prepare("INSERT OR IGNORE INTO state_subscription (thread_id) VALUES (?)").run(threadId);
    },
    unsubscribe: async (threadId) => {
      db.prepare("DELETE FROM state_subscription WHERE thread_id = ?").run(threadId);
    },
    isSubscribed: async (threadId) =>
      db.prepare("SELECT 1 FROM state_subscription WHERE thread_id = ?").get(threadId) !==
      undefined,

    acquireLock: async (threadId, ttlMs) => {
      const row = db
        .prepare(
          `INSERT INTO state_lock (thread_id, token, expires_at) VALUES (?, ?, ?)
            ON CONFLICT (thread_id) DO UPDATE
              SET token = excluded.token, expires_at = excluded.expires_at
              WHERE state_lock.expires_at <= ?
            RETURNING token, expires_at`,
        )
        .get(threadId, randomToken(), now() + ttlMs, now());
      return row === undefined
        ? null
        : ({
            threadId,
            token: String(row.token),
            expiresAt: Number(row.expires_at),
          } satisfies Lock);
    },
    extendLock: async (lock, ttlMs) =>
      db
        .prepare(
          `UPDATE state_lock SET expires_at = ?
            WHERE thread_id = ? AND token = ? AND expires_at > ? RETURNING thread_id`,
        )
        .all(now() + ttlMs, lock.threadId, lock.token, now()).length > 0,
    releaseLock: async (lock) => {
      db.prepare("DELETE FROM state_lock WHERE thread_id = ? AND token = ?").run(
        lock.threadId,
        lock.token,
      );
    },
    forceReleaseLock: async (threadId) => {
      db.prepare("DELETE FROM state_lock WHERE thread_id = ?").run(threadId);
    },

    get: async <T>(key: string) => {
      const row = db
        .prepare("SELECT value, expires_at FROM state_cache WHERE cache_key = ?")
        .get(key);
      if (row === undefined) return null;
      if (row.expires_at !== null && Number(row.expires_at) <= now()) {
        db.prepare("DELETE FROM state_cache WHERE cache_key = ? AND expires_at <= ?").run(
          key,
          now(),
        );
        return null;
      }
      return decode(row.value) as T;
    },
    set: async (key, value, ttlMs) => {
      db.prepare(
        `INSERT INTO state_cache (cache_key, value, expires_at) VALUES (?, ?, ?)
          ON CONFLICT (cache_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      ).run(key, encode(value), ttlMs ? now() + ttlMs : null);
    },
    setIfNotExists: async (key, value, ttlMs) =>
      db
        .prepare(
          `INSERT INTO state_cache (cache_key, value, expires_at) VALUES (?, ?, ?)
            ON CONFLICT (cache_key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
              WHERE state_cache.expires_at IS NOT NULL AND state_cache.expires_at <= ?
            RETURNING cache_key`,
        )
        .all(key, encode(value), ttlMs ? now() + ttlMs : null, now()).length > 0,
    delete: async (key) => {
      db.prepare("DELETE FROM state_cache WHERE cache_key = ?").run(key);
    },

    appendToList: async (key, value, listOptions) =>
      transaction(() => {
        const expiresAt = listOptions?.ttlMs ? now() + listOptions.ttlMs : null;
        db.prepare("INSERT INTO state_list (list_key, value, expires_at) VALUES (?, ?, ?)").run(
          key,
          encode(value),
          expiresAt,
        );
        if (listOptions?.maxLength) {
          db.prepare(
            `DELETE FROM state_list WHERE list_key = ? AND seq NOT IN (
              SELECT seq FROM state_list WHERE list_key = ? ORDER BY seq DESC LIMIT ?)`,
          ).run(key, key, listOptions.maxLength);
        }
        // The TTL covers the whole list, as in the SDK's own adapters.
        if (expiresAt !== null) {
          db.prepare("UPDATE state_list SET expires_at = ? WHERE list_key = ?").run(expiresAt, key);
        }
      }),
    getList: async <T>(key: string) =>
      db
        .prepare(
          `SELECT value FROM state_list
            WHERE list_key = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY seq ASC`,
        )
        .all(key, now())
        .map((row) => decode(row.value) as T),

    enqueue: async (threadId, entry, maxSize) =>
      transaction(() => {
        db.prepare("DELETE FROM state_queue WHERE thread_id = ? AND expires_at <= ?").run(
          threadId,
          now(),
        );
        db.prepare("INSERT INTO state_queue (thread_id, value, expires_at) VALUES (?, ?, ?)").run(
          threadId,
          encode(entry),
          entry.expiresAt,
        );
        if (maxSize > 0) {
          db.prepare(
            `DELETE FROM state_queue WHERE thread_id = ? AND seq NOT IN (
              SELECT seq FROM state_queue WHERE thread_id = ? ORDER BY seq DESC LIMIT ?)`,
          ).run(threadId, threadId, maxSize);
        }
        return count("SELECT count(*) AS depth FROM state_queue WHERE thread_id = ?", threadId);
      }),
    dequeue: async (threadId) =>
      transaction(() => {
        db.prepare("DELETE FROM state_queue WHERE thread_id = ? AND expires_at <= ?").run(
          threadId,
          now(),
        );
        const row = db
          .prepare(
            "SELECT seq, value FROM state_queue WHERE thread_id = ? ORDER BY seq ASC LIMIT 1",
          )
          .get(threadId);
        if (row === undefined) return null;
        db.prepare("DELETE FROM state_queue WHERE seq = ?").run(Number(row.seq));
        return decode(row.value) as QueueEntry;
      }),
    queueDepth: async (threadId) =>
      count(
        "SELECT count(*) AS depth FROM state_queue WHERE thread_id = ? AND expires_at > ?",
        threadId,
        now(),
      ),
  };
}
