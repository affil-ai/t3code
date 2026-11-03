// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * The bridge's own SQLite database: Slack messages saved but not yet handed
 * to T3 (the inbox), which T3 thread answers which Slack thread, which Slack
 * messages were already handled, and which runs still owe Slack a reply. The Chat SDK's state lives in the same file
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
  /** A muted thread only answers messages that mention the bot. */
  readonly muted?: boolean | undefined;
}

/** A message the agent sees with its next turn, without starting one. */
export interface ContextMessage {
  readonly eventId: string;
  readonly line: string;
}

export interface OwedReply {
  readonly runId: string;
  readonly threadId: string;
  readonly chatThreadKey: string;
}

/** A Slack message saved before the bridge acts on it, so a crash or a T3 failure cannot lose it. */
export interface InboxEntry {
  readonly eventId: string;
  readonly chatThreadKey: string;
  /** The inbound event as JSON. */
  readonly event: string;
  /** Failed hand-offs so far. */
  readonly attempts: number;
  /** Not tried again before this time, in epoch ms. */
  readonly retryAt: number;
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
      created_at INTEGER NOT NULL,
      muted INTEGER NOT NULL DEFAULT 0
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
    -- Slack messages saved on arrival and removed once handled; the bridge works from this table.
    CREATE TABLE IF NOT EXISTS inbox (
      event_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      event TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS inbox_thread ON inbox (chat_thread_key);
    -- Single values, such as how far back Slack has been read.
    CREATE TABLE IF NOT EXISTS bridge_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Messages kept for the thread's next turn: asides, replies in a muted thread, other people.
    CREATE TABLE IF NOT EXISTS thread_context (
      event_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      line TEXT NOT NULL
    );
  `);
  // Databases made before threads could be muted.
  const columns = db.prepare("PRAGMA table_info(binding)").all();
  if (!columns.some((column) => column.name === "muted")) {
    db.exec("ALTER TABLE binding ADD COLUMN muted INTEGER NOT NULL DEFAULT 0");
  }
}

const fromRow = (row: Record<string, unknown>): Binding => ({
  chatThreadKey: String(row.chat_thread_key),
  channelId: String(row.channel_id),
  projectId: String(row.project_id),
  threadId: String(row.thread_id),
  chatKey: String(row.chat_key),
  createdByUserId: String(row.created_by_user_id),
  muted: row.muted === 1,
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

  setMuted(chatThreadKey: string, muted: boolean): void {
    this.db
      .prepare("UPDATE binding SET muted = ? WHERE chat_thread_key = ?")
      .run(muted ? 1 : 0, chatThreadKey);
  }

  addContext(chatThreadKey: string, message: ContextMessage): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO thread_context (event_id, chat_thread_key, line) VALUES (?, ?, ?)",
      )
      .run(message.eventId, chatThreadKey, message.line);
  }

  /** The thread's kept messages, oldest first. */
  context(chatThreadKey: string): Array<ContextMessage> {
    return this.db
      .prepare("SELECT event_id, line FROM thread_context WHERE chat_thread_key = ? ORDER BY rowid")
      .all(chatThreadKey)
      .map((row) => ({ eventId: String(row.event_id), line: String(row.line) }));
  }

  /** Drops kept messages once a turn has carried them. */
  dropContext(eventIds: ReadonlyArray<string>): void {
    const remove = this.db.prepare("DELETE FROM thread_context WHERE event_id = ?");
    for (const eventId of eventIds) remove.run(eventId);
  }

  /** Bindings made since `since` (epoch ms), newest first. */
  recentBindings(since: number, limit: number): Array<Binding> {
    return this.db
      .prepare("SELECT * FROM binding WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?")
      .all(since, limit)
      .map(fromRow);
  }

  /** Saves a message to the inbox. False when it is already there or already handled. */
  enqueue(entry: Pick<InboxEntry, "eventId" | "chatThreadKey" | "event">): boolean {
    if (this.isHandled(entry.eventId)) return false;
    const inserted = this.db
      .prepare(
        `INSERT INTO inbox (event_id, chat_thread_key, event, retry_at) VALUES (?, ?, ?, 0)
          ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      )
      .all(entry.eventId, entry.chatThreadKey, entry.event);
    return inserted.length > 0;
  }

  /** The chat thread's oldest message still in the inbox. */
  inboxHead(chatThreadKey: string): InboxEntry | undefined {
    const row = this.db
      .prepare("SELECT * FROM inbox WHERE chat_thread_key = ? ORDER BY rowid LIMIT 1")
      .get(chatThreadKey);
    return row === undefined
      ? undefined
      : {
          eventId: String(row.event_id),
          chatThreadKey: String(row.chat_thread_key),
          event: String(row.event),
          attempts: Number(row.attempts),
          retryAt: Number(row.retry_at),
        };
  }

  /** Chat threads with messages in the inbox, in the order their oldest arrived. */
  inboxThreads(): Array<string> {
    return this.db
      .prepare("SELECT chat_thread_key FROM inbox GROUP BY chat_thread_key ORDER BY MIN(rowid)")
      .all()
      .map((row) => String(row.chat_thread_key));
  }

  retryLater(eventId: string, attempts: number, retryAt: number, error: string): void {
    this.db
      .prepare("UPDATE inbox SET attempts = ?, retry_at = ?, last_error = ? WHERE event_id = ?")
      .run(attempts, retryAt, error.slice(0, 1000), eventId);
  }

  /** Moves a message from the inbox to the handled list, in one step. */
  finish(eventId: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM inbox WHERE event_id = ?").run(eventId);
      this.markHandled(eventId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Every Slack message before this time (epoch ms) has been saved or handled. */
  caughtUpTo(): number | undefined {
    const row = this.db.prepare("SELECT value FROM bridge_meta WHERE key = 'caught_up_to'").get();
    return row === undefined ? undefined : Number(row.value);
  }

  setCaughtUpTo(time: number): void {
    this.db
      .prepare(
        `INSERT INTO bridge_meta (key, value) VALUES ('caught_up_to', ?)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(time));
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
