import * as NodeSqlite from "node:sqlite";

import { assert, it } from "vite-plus/test";

import { createChatState } from "./chatState.ts";

/** A state adapter on a fresh database with a clock the test moves by hand. */
function harness() {
  let now = 1_000;
  let tokens = 0;
  const state = createChatState(new NodeSqlite.DatabaseSync(":memory:"), {
    now: () => now,
    randomToken: () => `token-${++tokens}`,
  });
  return { state, advance: (ms: number) => void (now += ms) };
}

it("tracks subscriptions", async () => {
  const { state } = harness();
  await state.subscribe("slack:C1:1");
  await state.subscribe("slack:C1:1");
  assert.isTrue(await state.isSubscribed("slack:C1:1"));
  await state.unsubscribe("slack:C1:1");
  assert.isFalse(await state.isSubscribed("slack:C1:1"));
});

it("holds a lock until it is released or expires", async () => {
  const { state, advance } = harness();
  const lock = await state.acquireLock("t", 100);
  assert.deepStrictEqual(lock, { threadId: "t", token: "token-1", expiresAt: 1_100 });
  assert.isNull(await state.acquireLock("t", 100));
  advance(50);
  assert.isTrue(await state.extendLock(lock!, 100));
  advance(60);
  assert.isNull(await state.acquireLock("t", 100));
  advance(100);
  const next = await state.acquireLock("t", 100);
  assert.isNotNull(next);
  // The expired holder can neither extend nor release the new lock.
  assert.isFalse(await state.extendLock(lock!, 100));
  await state.releaseLock(lock!);
  assert.isNull(await state.acquireLock("t", 100));
  await state.forceReleaseLock("t");
  assert.isNotNull(await state.acquireLock("t", 100));
});

it("sets a key only when it is absent or expired", async () => {
  const { state, advance } = harness();
  assert.isTrue(await state.setIfNotExists("dedupe:e1", true, 1_000));
  assert.isFalse(await state.setIfNotExists("dedupe:e1", true, 1_000));
  advance(1_000);
  assert.isNull(await state.get("dedupe:e1"));
  assert.isTrue(await state.setIfNotExists("dedupe:e1", "again", 1_000));
  assert.strictEqual(await state.get("dedupe:e1"), "again");
  await state.set("plain", { a: 1 });
  assert.isFalse(await state.setIfNotExists("plain", { a: 2 }));
  assert.deepStrictEqual(await state.get("plain"), { a: 1 });
});

it("keeps the newest list entries", async () => {
  const { state, advance } = harness();
  for (const value of [1, 2, 3, 4]) {
    await state.appendToList("history", value, { maxLength: 3, ttlMs: 500 });
  }
  assert.deepStrictEqual(await state.getList("history"), [2, 3, 4]);
  advance(500);
  assert.deepStrictEqual(await state.getList("history"), []);
});

it("queues messages in order, dropping the oldest past the cap and expired ones", async () => {
  const { state, advance } = harness();
  const entry = (id: string, expiresAt: number) => ({
    enqueuedAt: 1_000,
    expiresAt,
    message: { id } as never,
  });
  assert.strictEqual(await state.enqueue("t", entry("m1", 5_000), 2), 1);
  assert.strictEqual(await state.enqueue("t", entry("m2", 1_200), 2), 2);
  assert.strictEqual(await state.enqueue("t", entry("m3", 5_000), 2), 2);
  advance(500);
  assert.strictEqual(await state.queueDepth("t"), 1);
  assert.deepStrictEqual((await state.dequeue("t"))?.message, { id: "m3" } as never);
  assert.isNull(await state.dequeue("t"));
});
