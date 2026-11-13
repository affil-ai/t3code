// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { assert, it } from "vite-plus/test";

import { BridgeStore, ensureSchema } from "./store.ts";

const freshStore = () => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  ensureSchema(db);
  return new BridgeStore(db);
};

const SESSION = "linear:issue-1:s:session-1";
const ISSUE = "linear:issue-1";

it("migrates old single bindings into unsynced groups and keeps replies and questions per conversation", () => {
  using db = new NodeSqlite.DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE binding (
      chat_thread_key TEXT PRIMARY KEY, channel_id TEXT NOT NULL, project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE, chat_key TEXT NOT NULL UNIQUE,
      created_by_user_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    INSERT INTO binding VALUES ('office:chat', 'chat', 'p', 't', 'key', 'member', 42);
    CREATE TABLE owed_reply (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
      chat_thread_key TEXT NOT NULL, posted_at INTEGER);
    INSERT INTO owed_reply VALUES ('r', 't', 'office:chat', NULL);
    CREATE TABLE question (request_id TEXT PRIMARY KEY, chat_thread_key TEXT NOT NULL,
      thread_id TEXT NOT NULL, asked TEXT NOT NULL, message_id TEXT NOT NULL DEFAULT '',
      closed INTEGER NOT NULL DEFAULT 0);
    INSERT INTO question VALUES ('q', 'office:chat', 't',
      '{"requestId":"q","questions":[],"answers":{},"submitted":[]}', '', 0);
  `);
  ensureSchema(db);
  ensureSchema(db);
  const store = new BridgeStore(db);
  const original = store.binding("office:chat")!;
  assert.equal(original.chatKey, "key");
  assert.isFalse(store.synced("t"));
  assert.deepEqual(store.recipients("office:chat"), ["office:chat"]);
  store.insertBinding({
    ...original,
    chatThreadKey: "slack:C:1",
    channelId: "C",
    chatKey: "other-key",
  });
  assert.lengthOf(store.bindingsForThread("t"), 2);
  store.setSync("t", true);
  assert.deepEqual(store.recipients("office:chat"), ["office:chat", "slack:C:1"]);
  store.usedConversation("slack:C:1");
  assert.equal(store.bindingByThreadId("t")?.chatThreadKey, "slack:C:1");
  const office = { runId: "r", threadId: "t", chatThreadKey: "office:chat" };
  const slack = { ...office, chatThreadKey: "slack:C:1" };
  store.oweReply(slack);
  assert.isTrue(store.claimReply(office));
  assert.deepEqual(store.pendingReplies(), [slack]);
  assert.isFalse(store.claimReply(office));
  assert.isTrue(store.claimReply(slack));
  store.releaseReply("r", "slack:C:1");
  assert.deepEqual(store.pendingReplies(), [slack]);
  const question = store.question("q", "office:chat")!;
  assert.isTrue(store.addQuestion({ ...question, chatThreadKey: "slack:C:1" }));
  store.updateQuestion({ ...question, closed: true });
  assert.lengthOf(store.openQuestions("office:chat"), 0);
  assert.lengthOf(store.openQuestions("slack:C:1"), 1);
});

it("moves a conversation to a new key with its context, and never onto a bound key", () => {
  const store = freshStore();
  store.insertBinding({
    chatThreadKey: SESSION,
    channelId: "ENG",
    projectId: "p",
    threadId: "thread-1",
    chatKey: "key-1",
    createdByUserId: "u",
  });
  store.addContext(SESSION, { eventId: "linear:c-2", line: "Ada: for the record" });
  assert.deepStrictEqual(store.boundKeys("linear:"), [SESSION]);
  assert.deepStrictEqual(store.boundKeys("slack:"), []);

  assert.isTrue(store.moveConversation(SESSION, ISSUE));
  assert.strictEqual(store.binding(ISSUE)?.threadId, "thread-1");
  assert.isUndefined(store.binding(SESSION));
  assert.deepStrictEqual(
    store.context(ISSUE).map((message) => message.line),
    ["Ada: for the record"],
  );
  // Moving again would overwrite the issue's conversation, so it refuses.
  store.insertBinding({
    chatThreadKey: SESSION,
    channelId: "ENG",
    projectId: "p",
    threadId: "thread-2",
    chatKey: "key-2",
    createdByUserId: "u",
  });
  assert.isFalse(store.moveConversation(SESSION, ISSUE));
  assert.strictEqual(store.binding(ISSUE)?.threadId, "thread-1");

  store.setMeta(`linear_session:${ISSUE}`, SESSION);
  assert.strictEqual(store.meta(`linear_session:${ISSUE}`), SESSION);
  assert.isUndefined(store.meta("missing"));
});

const bridgeSchema = (db: NodeSqlite.DatabaseSync) =>
  db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();

it("opens production's database of 2026-11-12 without changing its schema, and every binding still resolves", () => {
  using db = new NodeSqlite.DatabaseSync(":memory:");
  db.exec(
    NodeFS.readFileSync(new URL("./testdata/prod-schema-2026-11-12.sql", import.meta.url), "utf8"),
  );
  // Production's shapes: single Slack, Linear and iMessage bindings, and Office imports
  // grouping an Office chat with Slack threads, synced or not.
  db.exec(`
    INSERT INTO bridge_meta VALUES ('binding_groups_v1', '1');
    INSERT INTO binding (chat_thread_key, channel_id, project_id, thread_id, chat_key, created_by_user_id, created_at, muted) VALUES
      ('slack:C1:100.1', 'C1', 'p', 't-slack', 'k1', 'U1', 1, 0),
      ('linear:issue-1', 'ENG', 'p', 't-linear', 'k2', '', 2, 0),
      ('imessage:chat-1', 'chat-1', 'p', 't-imessage', 'k3', 'h', 3, 1),
      ('office:chat-a', 'chat-a', 'p', 't-synced', 'k4', 'm', 4, 0),
      ('slack:C2:200.1', 'C2', 'p', 't-synced', 'k5', 'm', 5, 0),
      ('slack:C2:200.2', 'C2', 'p', 't-synced', 'k6', 'm', 6, 0),
      ('office:chat-b', 'chat-b', 'p', 't-grouped', 'k7', 'm', 7, 0),
      ('slack:C3:300.1', 'C3', 'p', 't-grouped', 'k8', 'm', 8, 0);
    INSERT INTO binding_group VALUES
      ('t-slack', 0, 'slack:C1:100.1'), ('t-linear', 0, 'linear:issue-1'),
      ('t-imessage', 0, 'imessage:chat-1'), ('t-synced', 1, 'slack:C2:200.1'),
      ('t-grouped', 0, 'slack:C3:300.1');
    INSERT INTO owed_reply (run_id, thread_id, chat_thread_key, posted_at, requested_by, claimed) VALUES
      ('r1', 't-slack', 'slack:C1:100.1', 10, 'U1', 1), ('r2', 't-synced', 'office:chat-a', NULL, NULL, 0);
    INSERT INTO delegated_follow VALUES ('t-grouped', 'slack:C3:300.1', 'r3', NULL, 4, 99);
    INSERT INTO notification_cursor VALUES ('t-slack', 7);
  `);
  const before = bridgeSchema(db);
  ensureSchema(db);
  ensureSchema(db);
  // No migration ran, so the commit before this one opens the same file unchanged.
  assert.deepStrictEqual(bridgeSchema(db), before);

  const store = new BridgeStore(db);
  for (const [key, chatKey, threadId] of [
    ["slack:C1:100.1", "k1", "t-slack"],
    ["linear:issue-1", "k2", "t-linear"],
    ["imessage:chat-1", "k3", "t-imessage"],
    ["office:chat-a", "k4", "t-synced"],
    ["slack:C2:200.1", "k5", "t-synced"],
    ["slack:C2:200.2", "k6", "t-synced"],
    ["office:chat-b", "k7", "t-grouped"],
    ["slack:C3:300.1", "k8", "t-grouped"],
  ] as const) {
    assert.strictEqual(store.binding(key)?.threadId, threadId, key);
    assert.strictEqual(store.bindingByChatKey(chatKey)?.chatThreadKey, key, key);
  }
  assert.isTrue(store.binding("imessage:chat-1")?.muted);
  assert.strictEqual(store.bindingByThreadId("t-slack")?.chatThreadKey, "slack:C1:100.1");
  assert.strictEqual(store.bindingByThreadId("t-synced")?.chatThreadKey, "slack:C2:200.1");
  assert.deepStrictEqual(store.recipients("slack:C1:100.1"), ["slack:C1:100.1"]);
  assert.deepStrictEqual(store.recipients("slack:C2:200.2"), [
    "office:chat-a",
    "slack:C2:200.1",
    "slack:C2:200.2",
  ]);
  assert.deepStrictEqual(store.recipients("office:chat-b"), ["office:chat-b"]);
  assert.deepStrictEqual(
    store.pendingReplies().map((reply) => reply.runId),
    ["r2"],
  );
  assert.strictEqual(store.notificationCursor("t-slack"), 7);
});

it("unlinks one conversation of a group, moving its follow to the chat left, and ends a lone one's", () => {
  const store = freshStore();
  const bind = (chatThreadKey: string, chatKey: string, threadId = "t") =>
    store.insertBinding({
      chatThreadKey,
      channelId: "C1",
      projectId: "p",
      threadId,
      chatKey,
      createdByUserId: "",
    });
  bind("slack:C1:1.1", "a");
  bind("linear:issue-1", "b");
  bind("slack:C1:9.9", "c", "lone");
  store.usedConversation("linear:issue-1");
  store.oweReply({ runId: "r", threadId: "t", chatThreadKey: "linear:issue-1" });
  store.saveFollow({
    reply: { runId: "r", threadId: "t", chatThreadKey: "linear:issue-1" },
    cursor: 0,
    until: 1,
  });
  store.saveFollow({
    reply: { runId: "q", threadId: "lone", chatThreadKey: "slack:C1:9.9" },
    cursor: 0,
    until: 1,
  });
  assert.strictEqual(store.unlink("linear:issue-1")?.threadId, "t");
  assert.isUndefined(store.unlink("linear:issue-1"));
  assert.isUndefined(store.binding("linear:issue-1"));
  assert.isFalse(store.claimReply({ runId: "r", threadId: "t", chatThreadKey: "linear:issue-1" }));
  assert.strictEqual(store.bindingByThreadId("t")?.chatThreadKey, "slack:C1:1.1");
  assert.strictEqual(store.follows()[0]?.reply.chatThreadKey, "slack:C1:1.1");
  store.unlink("slack:C1:9.9");
  assert.deepStrictEqual(
    store.follows().map((follow) => follow.reply.threadId),
    ["t"],
  );
});
