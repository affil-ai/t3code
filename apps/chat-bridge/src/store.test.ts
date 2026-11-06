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
