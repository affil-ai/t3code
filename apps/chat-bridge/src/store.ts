// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * The bridge's own SQLite database: Slack messages saved but not yet handed
 * to T3 (the inbox), which T3 thread answers which Slack thread, which Slack
 * messages were already handled, and which runs still owe Slack a reply. The Chat SDK's state lives in the same file
 * (see `chatState.ts`).
 */
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";

import type { ModelSelection } from "./modelCommand.ts";
import type { Asked } from "./questions.ts";

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

export interface ConversationSeed {
  readonly chatThreadKey: string;
  readonly channelId: string;
  readonly chatId: string;
  readonly oldThreadId: string;
  readonly sync: boolean;
}

/** A message the agent sees with its next turn, without starting one. */
export interface ContextMessage {
  readonly eventId: string;
  readonly line: string;
}

/** A thread the bridge keeps following after its run, until its delegated work settles or `until`. */
export interface DelegatedFollow {
  readonly reply: OwedReply;
  /** Notifications at or before this position were looked at already. */
  readonly cursor: number;
  readonly until: number;
}

export interface OwedReply {
  readonly runId: string;
  readonly threadId: string;
  readonly chatThreadKey: string;
  /** The chat user whose message started or joined the run; Slack streams a channel reply to them. */
  readonly requestedBy?: string | undefined;
}

/** A request handed to a run that its platform has still to be told about. */
export interface OwedDispatch {
  readonly eventId: string;
  readonly chatThreadKey: string;
  readonly runId: string;
}

/** An agent's question as asked in the chat, with what has been answered. */
export interface AskedRecord {
  readonly chatThreadKey: string;
  readonly threadId: string;
  readonly asked: Asked;
  /** The chat message that shows the question; empty until it is posted. */
  readonly messageId: string;
  /** False until the question reaches the chat, so a failed post is tried again. */
  readonly posted: boolean;
  readonly closed: boolean;
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
    -- Messages handed to a T3 thread, by launching it or sending into it. Unlike
    -- handled_message, a resend keeps these, so it never hands a message to T3 twice.
    CREATE TABLE IF NOT EXISTS delivered_message (
      event_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      delivered_at INTEGER NOT NULL
    );
    -- Runs whose answer goes to Slack. posted_at is set once the reply is delivered.
    CREATE TABLE IF NOT EXISTS owed_reply (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      chat_thread_key TEXT NOT NULL,
      posted_at INTEGER
    );
    -- A thread whose run has ended while its subagents or background work go on,
    -- so a restart keeps owing the chat the runs they start when they report back.
    CREATE TABLE IF NOT EXISTS delegated_follow (
      thread_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      requested_by TEXT,
      cursor INTEGER NOT NULL,
      until_ms INTEGER NOT NULL
    );
    -- Each run a thread's follow waits on, released once its own delegated work settles or
    -- until_ms passes, so a later run's resources don't wait on, or end with, an earlier run's work.
    CREATE TABLE IF NOT EXISTS delegated_follow_run (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      chat_thread_key TEXT NOT NULL,
      requested_by TEXT,
      until_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS delegated_follow_run_thread ON delegated_follow_run (thread_id);
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
    -- Messages kept for the thread's next turn: messages for other bots, replies in a muted thread, other people.
    CREATE TABLE IF NOT EXISTS thread_context (
      event_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      line TEXT NOT NULL
    );
    -- Agents' questions asked in a chat thread; kept so a restart neither asks twice nor forgets answers.
    CREATE TABLE IF NOT EXISTS question (
      request_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      asked TEXT NOT NULL,
      message_id TEXT NOT NULL DEFAULT '',
      closed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS question_thread ON question (chat_thread_key);
    CREATE TABLE IF NOT EXISTS conversation_seed (
      chat_thread_key TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      old_thread_id TEXT NOT NULL,
      sync INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS seed_chat ON conversation_seed (chat_id);
    CREATE TABLE IF NOT EXISTS seed_receipt (
      chat_thread_key TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      old_thread_id TEXT NOT NULL,
      thread_id TEXT NOT NULL
    );
    -- Requests handed to a run whose platform has not yet been told so. Office finishes only the
    -- requests it was told about, so a restart tells it before the run's end is reported.
    CREATE TABLE IF NOT EXISTS owed_dispatch (
      event_id TEXT PRIMARY KEY,
      chat_thread_key TEXT NOT NULL,
      run_id TEXT NOT NULL
    );
    -- Rows from Office's Slack relay: 'started' once a try began, 'handled' once done, so a
    -- restart neither replays a handled row nor lets the Chat SDK's dedupe drop an unfinished one.
    CREATE TABLE IF NOT EXISTS slack_relay_row (
      row_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS slack_relay_row_at ON slack_relay_row (at);
    -- How far each bound thread's activity has been read for runs T3 starts with a
    -- notification, which the chat is owed; see \`Bridge.watchNotifications\`.
    CREATE TABLE IF NOT EXISTS notification_cursor (
      thread_id TEXT PRIMARY KEY,
      cursor INTEGER NOT NULL
    );
  `);
  // Databases made before threads could be muted, or replies knew who asked.
  addColumn(db, "binding", "muted", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "owed_reply", "requested_by", "TEXT");
  migrateBindingGroups(db);
  // After the migration above, which rebuilds binding: the chat's model the thread last
  // followed, as JSON; see `followedModel`.
  addColumn(db, "binding", "followed_model", "TEXT");
  // Set once a person picks the thread's model with `!model`; see `modelSwitched`.
  addColumn(db, "binding", "model_switched", "INTEGER NOT NULL DEFAULT 0");
  // A claimed reply is being answered; posted_at waits for delivery, so a crash in between resumes it.
  addColumn(db, "owed_reply", "claimed", "INTEGER NOT NULL DEFAULT 0");
  // Questions saved before this column were posted when saved.
  addColumn(db, "question", "posted", "INTEGER NOT NULL DEFAULT 1");
  // Feedback buttons were tried and removed (2026-11-04).
  db.exec("DROP TABLE IF EXISTS feedback");
}

function migrateBindingGroups(db: NodeSqlite.DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM bridge_meta WHERE key = 'binding_groups_v1'").get()) return;
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE binding_group (
        thread_id TEXT PRIMARY KEY,
        sync INTEGER NOT NULL DEFAULT 0,
        last_chat_thread_key TEXT NOT NULL
      );
      INSERT INTO binding_group (thread_id, last_chat_thread_key)
        SELECT thread_id, chat_thread_key FROM binding;
      CREATE TABLE binding_group_member (
        chat_thread_key TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        chat_key TEXT NOT NULL UNIQUE,
        created_by_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        muted INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO binding_group_member SELECT
        chat_thread_key, channel_id, project_id, thread_id, chat_key,
        created_by_user_id, created_at, muted FROM binding;
      DROP TABLE binding;
      ALTER TABLE binding_group_member RENAME TO binding;
      CREATE INDEX binding_thread ON binding (thread_id);
      CREATE TABLE owed_reply_group (
        run_id TEXT NOT NULL, thread_id TEXT NOT NULL, chat_thread_key TEXT NOT NULL,
        posted_at INTEGER, requested_by TEXT, PRIMARY KEY (run_id, chat_thread_key)
      );
      INSERT INTO owed_reply_group SELECT run_id, thread_id, chat_thread_key, posted_at, requested_by FROM owed_reply;
      DROP TABLE owed_reply;
      ALTER TABLE owed_reply_group RENAME TO owed_reply;
      CREATE TABLE question_group (
        request_id TEXT NOT NULL, chat_thread_key TEXT NOT NULL, thread_id TEXT NOT NULL,
        asked TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '', closed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (request_id, chat_thread_key)
      );
      INSERT INTO question_group SELECT request_id, chat_thread_key, thread_id, asked, message_id, closed FROM question;
      DROP TABLE question;
      ALTER TABLE question_group RENAME TO question;
      CREATE INDEX question_thread ON question (chat_thread_key);
      INSERT INTO bridge_meta (key, value) VALUES ('binding_groups_v1', '1');
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function addColumn(db: NodeSqlite.DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((each) => each.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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

const questionFromRow = (row: Record<string, unknown>): AskedRecord => ({
  chatThreadKey: String(row.chat_thread_key),
  threadId: String(row.thread_id),
  asked: JSON.parse(String(row.asked)) as Asked,
  messageId: String(row.message_id),
  posted: row.posted === 1,
  closed: row.closed === 1,
});

export class BridgeStore {
  private readonly db: NodeSqlite.DatabaseSync;
  private readonly now: () => number;

  constructor(db: NodeSqlite.DatabaseSync, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** Runs `run` in one transaction, or inside the one already open. */
  transaction<T>(run: () => T): T {
    if (this.db.isTransaction) return run();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  seed(chatThreadKey: string): ConversationSeed | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversation_seed WHERE chat_thread_key = ?")
      .get(chatThreadKey);
    return row === undefined
      ? undefined
      : {
          chatThreadKey: String(row.chat_thread_key),
          channelId: String(row.channel_id),
          chatId: String(row.chat_id),
          oldThreadId: String(row.old_thread_id),
          sync: row.sync === 1,
        };
  }

  seeds(chatId: string): Array<ConversationSeed> {
    return this.db
      .prepare(
        "SELECT chat_thread_key FROM conversation_seed WHERE chat_id = ? ORDER BY chat_thread_key",
      )
      .all(chatId)
      .map((row) => this.seed(String(row.chat_thread_key))!);
  }

  seedKeys(prefix: string): Array<string> {
    return this.db
      .prepare(
        "SELECT chat_thread_key FROM conversation_seed WHERE substr(chat_thread_key, 1, ?) = ?",
      )
      .all(prefix.length, prefix)
      .map((row) => String(row.chat_thread_key));
  }

  seedReceipt(key: string): { chatId: string; oldThreadId: string; threadId: string } | undefined {
    const row = this.db.prepare("SELECT * FROM seed_receipt WHERE chat_thread_key = ?").get(key);
    return row === undefined
      ? undefined
      : {
          chatId: String(row.chat_id),
          oldThreadId: String(row.old_thread_id),
          threadId: String(row.thread_id),
        };
  }

  insertSeed(seed: ConversationSeed): void {
    this.db
      .prepare(`INSERT INTO conversation_seed
      (chat_thread_key, channel_id, chat_id, old_thread_id, sync) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (chat_thread_key) DO NOTHING`)
      .run(seed.chatThreadKey, seed.channelId, seed.chatId, seed.oldThreadId, seed.sync ? 1 : 0);
  }

  /** Publish every destination and its import receipt in the same transaction as removing the seeds. */
  consumeSeed(source: ConversationSeed, binding: Binding): void {
    this.transaction(() => {
      for (const seed of this.seeds(source.chatId)) {
        const existing = this.binding(seed.chatThreadKey);
        if (existing && existing.threadId !== binding.threadId)
          throw new Error("Seed destination is already bound to another thread.");
        this.insertBinding({
          ...binding,
          chatThreadKey: seed.chatThreadKey,
          channelId: seed.channelId,
          chatKey:
            seed.chatThreadKey === binding.chatThreadKey
              ? binding.chatKey
              : NodeCrypto.randomBytes(16).toString("hex"),
        });
        this.db
          .prepare(
            "INSERT INTO seed_receipt (chat_thread_key, chat_id, old_thread_id, thread_id) VALUES (?, ?, ?, ?)",
          )
          .run(seed.chatThreadKey, seed.chatId, seed.oldThreadId, binding.threadId);
      }
      this.setSync(binding.threadId, source.sync);
      this.db.prepare("DELETE FROM conversation_seed WHERE chat_id = ?").run(source.chatId);
    });
  }

  /**
   * The chat's own model selection the bound thread last followed, such as
   * Office's picker. A follow-up switches the thread only when the chat's
   * selection changes from this, so a `!model` switch since then stands.
   */
  followedModel(chatThreadKey: string): ModelSelection | undefined {
    const row = this.db
      .prepare("SELECT followed_model FROM binding WHERE chat_thread_key = ?")
      .get(chatThreadKey);
    const value = row?.followed_model;
    return typeof value === "string" ? (JSON.parse(value) as ModelSelection) : undefined;
  }

  setFollowedModel(chatThreadKey: string, selection: ModelSelection): void {
    this.db
      .prepare("UPDATE binding SET followed_model = ? WHERE chat_thread_key = ?")
      .run(JSON.stringify(selection), chatThreadKey);
  }

  /**
   * Whether a person ever picked this thread's model with `!model`, so a thread
   * with no followed model that sits on a former default was put there on purpose.
   */
  modelSwitched(chatThreadKey: string): boolean {
    const row = this.db
      .prepare("SELECT model_switched FROM binding WHERE chat_thread_key = ?")
      .get(chatThreadKey);
    return row?.model_switched === 1;
  }

  markModelSwitched(chatThreadKey: string): void {
    this.db
      .prepare("UPDATE binding SET model_switched = 1 WHERE chat_thread_key = ?")
      .run(chatThreadKey);
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

  bindingByThreadId(threadId: string): Binding | undefined {
    const row = this.db
      .prepare(`SELECT b.* FROM binding b
      LEFT JOIN binding_group g ON g.thread_id = b.thread_id
      WHERE b.thread_id = ? ORDER BY b.chat_thread_key = g.last_chat_thread_key DESC, b.rowid LIMIT 1`)
      .get(threadId);
    return row === undefined ? undefined : fromRow(row);
  }

  bindingsForThread(threadId: string): Array<Binding> {
    return this.db
      .prepare("SELECT * FROM binding WHERE thread_id = ? ORDER BY rowid")
      .all(threadId)
      .map(fromRow);
  }

  synced(threadId: string): boolean {
    return (
      this.db.prepare("SELECT sync FROM binding_group WHERE thread_id = ?").get(threadId)?.sync ===
      1
    );
  }

  setSync(threadId: string, sync: boolean): void {
    this.db
      .prepare("UPDATE binding_group SET sync = ? WHERE thread_id = ?")
      .run(sync ? 1 : 0, threadId);
  }

  usedConversation(chatThreadKey: string): void {
    this.db
      .prepare(`UPDATE binding_group SET last_chat_thread_key = ?
      WHERE thread_id = (SELECT thread_id FROM binding WHERE chat_thread_key = ?)`)
      .run(chatThreadKey, chatThreadKey);
  }

  recipients(chatThreadKey: string): Array<string> {
    const binding = this.binding(chatThreadKey);
    return binding !== undefined && this.synced(binding.threadId)
      ? this.bindingsForThread(binding.threadId).map((each) => each.chatThreadKey)
      : [chatThreadKey];
  }

  /** Binds the conversation to another thread, replacing its binding if it has one. */
  replaceBinding(binding: Binding): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM binding WHERE chat_thread_key = ?").run(binding.chatThreadKey);
      this.insertBinding(binding);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertBinding(binding: Binding): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO binding_group (thread_id, last_chat_thread_key) VALUES (?, ?)`,
      )
      .run(binding.threadId, binding.chatThreadKey);
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

  /** Adopts history without owing any earlier run's answer or replacing a binding. */
  adoptBinding(input: Omit<Binding, "chatKey">): Binding {
    const existing = this.binding(input.chatThreadKey);
    if (existing !== undefined && existing.threadId !== input.threadId) {
      throw new Error("Cannot adopt a conversation bound to another T3 thread.");
    }
    if (existing !== undefined) return existing;
    this.insertBinding({ ...input, chatKey: NodeCrypto.randomBytes(16).toString("hex") });
    return this.binding(input.chatThreadKey)!;
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

  /** The keys of bound conversations that start with `prefix`, such as `linear:`. */
  boundKeys(prefix: string): Array<string> {
    return this.db
      .prepare("SELECT chat_thread_key FROM binding WHERE substr(chat_thread_key, 1, ?) = ?")
      .all(prefix.length, prefix)
      .map((row) => String(row.chat_thread_key));
  }

  /**
   * Gives a conversation a new key in every table, such as when Linear moved
   * from one per session to one per issue. False when `to` is already bound.
   */
  moveConversation(from: string, to: string): boolean {
    if (this.binding(to) !== undefined) return false;
    this.db.exec("BEGIN");
    try {
      for (const table of ["binding", "thread_context", "owed_reply", "inbox", "question"]) {
        this.db
          .prepare(`UPDATE ${table} SET chat_thread_key = ? WHERE chat_thread_key = ?`)
          .run(to, from);
      }
      this.db
        .prepare("UPDATE binding_group SET last_chat_thread_key = ? WHERE last_chat_thread_key = ?")
        .run(to, from);
      for (const table of ["delegated_follow", "delegated_follow_run"]) {
        this.db
          .prepare(`UPDATE ${table} SET chat_thread_key = ? WHERE chat_thread_key = ?`)
          .run(to, from);
      }
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
    return this.inbox(chatThreadKey, 1)[0];
  }

  /** The oldest message in these chat threads' inboxes. */
  inboxGroupHead(keys: ReadonlyArray<string>): InboxEntry | undefined {
    if (keys.length === 0) return undefined;
    const row = this.db
      .prepare(
        `SELECT * FROM inbox WHERE chat_thread_key IN (${keys.map(() => "?").join(",")}) ORDER BY rowid LIMIT 1`,
      )
      .get(...keys);
    return row ? inboxFromRow(row) : undefined;
  }

  /** The chat thread's messages still in the inbox, oldest first. */
  inbox(chatThreadKey: string, limit = 50): ReadonlyArray<InboxEntry> {
    return this.db
      .prepare("SELECT * FROM inbox WHERE chat_thread_key = ? ORDER BY rowid LIMIT ?")
      .all(chatThreadKey, limit)
      .map(inboxFromRow);
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
    this.transaction(() => {
      this.db.prepare("DELETE FROM inbox WHERE event_id = ?").run(eventId);
      this.markHandled(eventId);
    });
  }

  /** Every Slack message before this time (epoch ms) has been saved or handled. */
  caughtUpTo(): number | undefined {
    const value = this.meta("caught_up_to");
    return value === undefined ? undefined : Number(value);
  }

  setCaughtUpTo(time: number): void {
    this.setMeta("caught_up_to", String(time));
  }

  /** A value a platform keeps across restarts, such as the session a Linear issue answers in. */
  meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM bridge_meta WHERE key = ?").get(key);
    return row === undefined ? undefined : String(row.value);
  }

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM bridge_meta WHERE key = ?").run(key);
  }

  /** True while any run in the thread is owed an answer that hasn't been posted or given up on. */
  owesThread(threadId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM owed_reply WHERE thread_id = ? AND posted_at IS NULL LIMIT 1")
        .get(threadId) !== undefined
    );
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO bridge_meta (key, value) VALUES (?, ?)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** True once every chat owed the run's reply has had it, or given it up as quiet. */
  isAnswered(runId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS owed, COUNT(posted_at) AS posted FROM owed_reply WHERE run_id = ?",
      )
      .get(runId);
    return Number(row?.owed ?? 0) > 0 && Number(row?.owed) === Number(row?.posted);
  }

  /** True once the chat is owed the run's reply, whether or not it was posted. */
  isOwed(runId: string): boolean {
    return this.db.prepare("SELECT 1 FROM owed_reply WHERE run_id = ?").get(runId) !== undefined;
  }

  isHandled(eventId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM handled_message WHERE event_id = ?").get(eventId) !== undefined
    );
  }

  /** True once the relayed Slack row was handled (or given up on). */
  relayRowHandled(rowId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM slack_relay_row WHERE row_id = ? AND state = 'handled'")
        .get(rowId) !== undefined
    );
  }

  /** Records that a try of the relayed row is starting; true when an earlier try already started. */
  beginRelayRow(rowId: string): boolean {
    return this.transaction(() => {
      const earlier =
        this.db.prepare("SELECT 1 FROM slack_relay_row WHERE row_id = ?").get(rowId) !== undefined;
      this.db
        .prepare(
          `INSERT INTO slack_relay_row (row_id, state, at) VALUES (?, 'started', ?)
            ON CONFLICT (row_id) DO NOTHING`,
        )
        .run(rowId, this.now());
      return earlier;
    });
  }

  /** Records the relayed row as handled, and forgets rows older than `keepMs`. */
  finishRelayRow(rowId: string, keepMs: number): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO slack_relay_row (row_id, state, at) VALUES (?, 'handled', ?)
            ON CONFLICT (row_id) DO UPDATE SET state = 'handled', at = excluded.at`,
        )
        .run(rowId, this.now());
      this.db.prepare("DELETE FROM slack_relay_row WHERE at < ?").run(this.now() - keepMs);
    });
  }

  /**
   * Forgets that a message was handled, saved or kept as context, so it can be
   * saved again as new. For an operator's resend, with the bridge stopped.
   */
  forgetMessage(eventId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM handled_message WHERE event_id = ?").run(eventId);
      this.db.prepare("DELETE FROM inbox WHERE event_id = ?").run(eventId);
      this.db.prepare("DELETE FROM thread_context WHERE event_id = ?").run(eventId);
    });
  }

  /** Records that the message reached this T3 thread. */
  markDelivered(eventId: string, threadId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO delivered_message (event_id, thread_id, delivered_at) VALUES (?, ?, ?)",
      )
      .run(eventId, threadId, this.now());
  }

  /**
   * The T3 thread the message reached, if any. Messages handled before this was
   * recorded count when they launched their chat's bound thread: the launch's
   * chat key is the binding's.
   */
  deliveredTo(eventId: string, chatThreadKey: string): string | undefined {
    const row = this.db
      .prepare("SELECT thread_id FROM delivered_message WHERE event_id = ?")
      .get(eventId);
    if (row !== undefined) return String(row.thread_id);
    const binding = this.binding(chatThreadKey);
    const launched = this.meta(`launch_chat_key:${eventId}`);
    return binding !== undefined && launched === binding.chatKey ? binding.threadId : undefined;
  }

  markHandled(eventId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO handled_message (event_id, handled_at) VALUES (?, ?)")
      .run(eventId, this.now());
  }

  oweReply(reply: OwedReply): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO owed_reply (run_id, thread_id, chat_thread_key, requested_by)
          VALUES (?, ?, ?, ?)`,
      )
      .run(reply.runId, reply.threadId, reply.chatThreadKey, reply.requestedBy ?? null);
  }

  oweDispatch(dispatch: OwedDispatch): void {
    this.db
      .prepare(
        `INSERT INTO owed_dispatch (event_id, chat_thread_key, run_id) VALUES (?, ?, ?)
          ON CONFLICT (event_id) DO UPDATE SET chat_thread_key = excluded.chat_thread_key,
            run_id = excluded.run_id`,
      )
      .run(dispatch.eventId, dispatch.chatThreadKey, dispatch.runId);
  }

  /** Requests whose platform has still to be told they reached a run, oldest first. */
  owedDispatches(chatThreadKey?: string): Array<OwedDispatch> {
    const rows =
      chatThreadKey === undefined
        ? this.db.prepare("SELECT * FROM owed_dispatch ORDER BY rowid").all()
        : this.db
            .prepare("SELECT * FROM owed_dispatch WHERE chat_thread_key = ? ORDER BY rowid")
            .all(chatThreadKey);
    return rows.map((row) => ({
      eventId: String(row.event_id),
      chatThreadKey: String(row.chat_thread_key),
      runId: String(row.run_id),
    }));
  }

  dispatchSent(eventId: string): void {
    this.db.prepare("DELETE FROM owed_dispatch WHERE event_id = ?").run(eventId);
  }

  /** Saves a question when it is first seen. False when it was already saved. */
  addQuestion(record: AskedRecord): boolean {
    const inserted = this.db
      .prepare(
        `INSERT INTO question (request_id, chat_thread_key, thread_id, asked, message_id, posted, closed)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (request_id, chat_thread_key) DO NOTHING RETURNING request_id`,
      )
      .all(
        record.asked.requestId,
        record.chatThreadKey,
        record.threadId,
        JSON.stringify(record.asked),
        record.messageId,
        record.posted ? 1 : 0,
        record.closed ? 1 : 0,
      );
    return inserted.length > 0;
  }

  updateQuestion(record: AskedRecord): void {
    this.db
      .prepare(
        "UPDATE question SET asked = ?, message_id = ?, posted = ?, closed = ? WHERE request_id = ? AND chat_thread_key = ?",
      )
      .run(
        JSON.stringify(record.asked),
        record.messageId,
        record.posted ? 1 : 0,
        record.closed ? 1 : 0,
        record.asked.requestId,
        record.chatThreadKey,
      );
  }

  question(requestId: string, chatThreadKey?: string): AskedRecord | undefined {
    const row =
      chatThreadKey === undefined
        ? this.db.prepare("SELECT * FROM question WHERE request_id = ?").get(requestId)
        : this.db
            .prepare("SELECT * FROM question WHERE request_id = ? AND chat_thread_key = ?")
            .get(requestId, chatThreadKey);
    return row === undefined ? undefined : questionFromRow(row);
  }

  questionCopies(requestId: string): Array<AskedRecord> {
    return this.db
      .prepare("SELECT * FROM question WHERE request_id = ?")
      .all(requestId)
      .map(questionFromRow);
  }

  /** The chat thread's questions still waiting, oldest first. */
  openQuestions(chatThreadKey: string): Array<AskedRecord> {
    return this.db
      .prepare("SELECT * FROM question WHERE chat_thread_key = ? AND closed = 0 ORDER BY rowid")
      .all(chatThreadKey)
      .map(questionFromRow);
  }

  /** Replies not yet posted or being answered, oldest first; the watcher resumes these at startup. */
  pendingReplies(): Array<OwedReply> {
    return this.db
      .prepare("SELECT * FROM owed_reply WHERE posted_at IS NULL AND claimed = 0 ORDER BY rowid")
      .all()
      .map((row) => ({
        runId: String(row.run_id),
        threadId: String(row.thread_id),
        chatThreadKey: String(row.chat_thread_key),
        ...(row.requested_by === null ? {} : { requestedBy: String(row.requested_by) }),
      }));
  }

  /**
   * True the first time a run's reply is claimed for answering. A run that
   * never owed a reply, such as a restart's continuation, is recorded as
   * claimed. `deliveredReply` or `releaseReply` ends the claim.
   */
  claimReply(reply: OwedReply): boolean {
    this.oweReply(reply);
    const claimed = this.db
      .prepare(
        "UPDATE owed_reply SET claimed = 1 WHERE run_id = ? AND chat_thread_key = ? AND posted_at IS NULL AND claimed = 0 RETURNING run_id",
      )
      .all(reply.runId, reply.chatThreadKey);
    return claimed.length > 0;
  }

  /** The claimed reply reached the chat, or chose to post nothing. */
  deliveredReply(runId: string, chatThreadKey: string): void {
    this.db
      .prepare("UPDATE owed_reply SET posted_at = ? WHERE run_id = ? AND chat_thread_key = ?")
      .run(this.now(), runId, chatThreadKey);
  }

  /** Claims a process that stopped never delivered, owed again so a restart answers them. */
  releaseUnfinishedClaims(): void {
    this.db.prepare("UPDATE owed_reply SET claimed = 0 WHERE posted_at IS NULL").run();
  }

  saveFollow(follow: DelegatedFollow): void {
    this.db
      .prepare(
        `INSERT INTO delegated_follow (thread_id, chat_thread_key, run_id, requested_by, cursor, until_ms)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (thread_id) DO UPDATE SET chat_thread_key = excluded.chat_thread_key,
            run_id = excluded.run_id, requested_by = excluded.requested_by,
            cursor = excluded.cursor, until_ms = excluded.until_ms`,
      )
      .run(
        follow.reply.threadId,
        follow.reply.chatThreadKey,
        follow.reply.runId,
        follow.reply.requestedBy ?? null,
        follow.cursor,
        follow.until,
      );
  }

  moveFollowCursor(threadId: string, cursor: number): void {
    this.db
      .prepare("UPDATE delegated_follow SET cursor = ? WHERE thread_id = ?")
      .run(cursor, threadId);
  }

  endFollow(threadId: string): void {
    this.db.prepare("DELETE FROM delegated_follow WHERE thread_id = ?").run(threadId);
  }

  /** The activity position the thread's notification runs have been read to, if it has one. */
  notificationCursor(threadId: string): number | undefined {
    const row = this.db
      .prepare("SELECT cursor FROM notification_cursor WHERE thread_id = ?")
      .get(threadId);
    return row === undefined ? undefined : Number(row.cursor);
  }

  /** Where reading the thread's notification runs starts; a thread that has a cursor keeps it. */
  startNotificationCursor(threadId: string, cursor: number): void {
    this.db
      .prepare(
        "INSERT INTO notification_cursor (thread_id, cursor) VALUES (?, ?) ON CONFLICT (thread_id) DO NOTHING",
      )
      .run(threadId, cursor);
  }

  moveNotificationCursor(threadId: string, cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO notification_cursor (thread_id, cursor) VALUES (?, ?)
          ON CONFLICT (thread_id) DO UPDATE SET cursor = excluded.cursor`,
      )
      .run(threadId, cursor);
  }

  /** Bound threads with no notification cursor yet. */
  threadsWithoutNotificationCursor(): Array<string> {
    return this.db
      .prepare(
        `SELECT DISTINCT b.thread_id FROM binding b
          LEFT JOIN notification_cursor c ON c.thread_id = b.thread_id
          WHERE c.thread_id IS NULL ORDER BY b.thread_id`,
      )
      .all()
      .map((row) => String(row.thread_id));
  }

  /** Adds a run to its thread's follow; a run already there keeps its cap. */
  addFollowRun(reply: OwedReply, until: number): void {
    this.db
      .prepare(
        `INSERT INTO delegated_follow_run (run_id, thread_id, chat_thread_key, requested_by, until_ms)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (run_id) DO NOTHING`,
      )
      .run(reply.runId, reply.threadId, reply.chatThreadKey, reply.requestedBy ?? null, until);
  }

  /** The runs a follow still waits on, oldest first: the thread's, or every thread's. */
  followRuns(threadId?: string): Array<{ readonly reply: OwedReply; readonly until: number }> {
    const rows =
      threadId === undefined
        ? this.db.prepare("SELECT * FROM delegated_follow_run ORDER BY rowid").all()
        : this.db
            .prepare("SELECT * FROM delegated_follow_run WHERE thread_id = ? ORDER BY rowid")
            .all(threadId);
    return rows.map((row) => ({
      reply: {
        runId: String(row.run_id),
        threadId: String(row.thread_id),
        chatThreadKey: String(row.chat_thread_key),
        ...(row.requested_by === null ? {} : { requestedBy: String(row.requested_by) }),
      },
      until: Number(row.until_ms),
    }));
  }

  endFollowRun(runId: string): void {
    this.db.prepare("DELETE FROM delegated_follow_run WHERE run_id = ?").run(runId);
  }

  follows(): Array<DelegatedFollow> {
    return this.db
      .prepare("SELECT * FROM delegated_follow ORDER BY rowid")
      .all()
      .map((row) => ({
        reply: {
          runId: String(row.run_id),
          threadId: String(row.thread_id),
          chatThreadKey: String(row.chat_thread_key),
          ...(row.requested_by === null ? {} : { requestedBy: String(row.requested_by) }),
        },
        cursor: Number(row.cursor),
        until: Number(row.until_ms),
      }));
  }

  releaseReply(runId: string, chatThreadKey?: string): void {
    if (chatThreadKey === undefined)
      this.db
        .prepare("UPDATE owed_reply SET posted_at = NULL, claimed = 0 WHERE run_id = ?")
        .run(runId);
    else
      this.db
        .prepare(
          "UPDATE owed_reply SET posted_at = NULL, claimed = 0 WHERE run_id = ? AND chat_thread_key = ?",
        )
        .run(runId, chatThreadKey);
  }
}

function inboxFromRow(row: Record<string, unknown>): InboxEntry {
  return {
    eventId: String(row.event_id),
    chatThreadKey: String(row.chat_thread_key),
    event: String(row.event),
    attempts: Number(row.attempts),
    retryAt: Number(row.retry_at),
  };
}
