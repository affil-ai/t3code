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
