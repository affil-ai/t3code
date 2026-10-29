// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * The bridge's own SQLite database: which T3 thread answers which Slack
 * thread, which Slack messages were already handed to T3, and which runs
 * still owe Slack a reply. The Chat SDK's state lives in the same file
 * (see `chatState.ts`).
 */
import * as NodeSqlite from "node:sqlite";

export interface Binding {
  /** The Chat SDK thread id, such as `slack:C0123:1700000000.000100`. */
  readonly chatThreadKey: string;
  readonly channelId: string;
  readonly projectId: string;
  readonly threadId: string;
  /** The random key the agent passes to `chat_post` and `chat_react`. */
  readonly chatKey: string;
  readonly createdByUserId: string;
}

export interface OwedReply {
  readonly runId: string;
  readonly threadId: string;
  readonly chatThreadKey: string;
}

export function openDatabase(filename: string): NodeSqlite.DatabaseSync {
  const db = new NodeSqlite.DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  ensureSchema(db);
  return db;
}

export function ensureSchema(db: NodeSqlite.DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS binding (
      chat_thread_key TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      chat_key TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    -- Slack messages already handed to T3, so a redelivery never sends twice.
    CREATE TABLE IF NOT EXISTS handled_message (
      event_id TEXT PRIMARY KEY,
      handled_at INTEGER NOT NULL
    );
    -- Runs whose answer goes to Slack. posted_at is set when the reply is claimed.
    CREATE TABLE IF NOT EXISTS owed_reply (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      chat_thread_key TEXT NOT NULL,
      posted_at INTEGER
    );
  `);
}

const fromRow = (row: Record<string, unknown>): Binding => ({
  chatThreadKey: String(row.chat_thread_key),
  channelId: String(row.channel_id),
  projectId: String(row.project_id),
  threadId: String(row.thread_id),
  chatKey: String(row.chat_key),
  createdByUserId: String(row.created_by_user_id),
});

export class BridgeStore {
  private readonly db: NodeSqlite.DatabaseSync;
  private readonly now: () => number;

  constructor(db: NodeSqlite.DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  binding(chatThreadKey: string): Binding | undefined {
    const row = this.db
      .prepare("SELECT * FROM binding WHERE chat_thread_key = ?")
      .get(chatThreadKey);
    return row === undefined ? undefined : fromRow(row);
  }

  bindingByChatKey(chatKey: string): Binding | undefined {
    const row = this.db.prepare("SELECT * FROM binding WHERE chat_key = ?").get(chatKey);
    return row === undefined ? undefined : fromRow(row);
  }

  insertBinding(binding: Binding): void {
    this.db
      .prepare(
        `INSERT INTO binding
          (chat_thread_key, channel_id, project_id, thread_id, chat_key, created_by_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (chat_thread_key) DO NOTHING`,
      )
      .run(
        binding.chatThreadKey,
        binding.channelId,
        binding.projectId,
        binding.threadId,
        binding.chatKey,
        binding.createdByUserId,
        this.now(),
      );
  }

  isHandled(eventId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM handled_message WHERE event_id = ?").get(eventId) !== undefined
    );
  }

  markHandled(eventId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO handled_message (event_id, handled_at) VALUES (?, ?)")
      .run(eventId, this.now());
  }

  oweReply(reply: OwedReply): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO owed_reply (run_id, thread_id, chat_thread_key) VALUES (?, ?, ?)",
      )
      .run(reply.runId, reply.threadId, reply.chatThreadKey);
  }

  /** Replies not yet posted, oldest first; the watcher resumes these at startup. */
  pendingReplies(): Array<OwedReply> {
    return this.db
      .prepare("SELECT * FROM owed_reply WHERE posted_at IS NULL ORDER BY rowid")
      .all()
      .map((row) => ({
        runId: String(row.run_id),
        threadId: String(row.thread_id),
        chatThreadKey: String(row.chat_thread_key),
      }));
  }

  /**
   * True the first time a run's reply is claimed. A run that never owed a
   * reply, such as a restart's continuation, is recorded as claimed.
   */
  claimReply(reply: OwedReply): boolean {
    this.oweReply(reply);
    const claimed = this.db
      .prepare(
        "UPDATE owed_reply SET posted_at = ? WHERE run_id = ? AND posted_at IS NULL RETURNING run_id",
      )
      .all(this.now(), reply.runId);
    return claimed.length > 0;
  }

  releaseReply(runId: string): void {
    this.db.prepare("UPDATE owed_reply SET posted_at = NULL WHERE run_id = ?").run(runId);
  }
}
