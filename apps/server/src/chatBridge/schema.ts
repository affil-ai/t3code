/**
 * The chat bridge's SQLite tables. They are fork-only, so like Firstmate's
 * they are created on every service start instead of joining the numbered
 * upstream migration list.
 *
 * `chat_bridge_state_*` back the Chat SDK's state adapter; the rest belong to
 * the bridge itself.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const ensureSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_bridge_config (
      platform TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // One chat thread drives one T3 thread, and a T3 thread answers at most one chat thread.
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_bridge_binding (
      chat_thread_key TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  // A row per run whose answer was posted (or is being posted), so a replayed
  // run event never posts twice.
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_bridge_reply (
      run_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      claimed_at TEXT NOT NULL
    )
  `;
  // Runs a chat follow-up joined without starting them, such as a steer into
  // a run started in T3. Runs the bridge started are known by their message id.
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_bridge_owed_reply (
      run_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_bridge_state_subscription (
      thread_id TEXT PRIMARY KEY
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_bridge_state_lock (
      thread_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_bridge_state_cache (
      cache_key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_bridge_state_list (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      list_key TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS chat_bridge_state_list_key ON chat_bridge_state_list (list_key, seq)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_bridge_state_queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS chat_bridge_state_queue_thread ON chat_bridge_state_queue (thread_id, seq)`;
});
