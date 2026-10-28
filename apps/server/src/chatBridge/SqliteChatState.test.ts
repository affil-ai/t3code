import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";

import * as SqliteChatState from "./SqliteChatState.ts";

/** A state adapter on a fresh database with a clock the test moves by hand. */
const makeState = Effect.gen(function* () {
  let now = 1_000;
  let tokens = 0;
  const state = yield* SqliteChatState.make({
    now: () => now,
    randomToken: Effect.sync(() => `token-${++tokens}`),
  });
  yield* Effect.promise(() => state.connect());
  return { state, advance: (ms: number) => void (now += ms) };
});

const test = (name: string, body: (harness: Effect.Success<typeof makeState>) => Promise<void>) =>
  it.effect(name, () =>
    makeState.pipe(
      Effect.flatMap((harness) => Effect.promise(() => body(harness))),
      Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  );

test("tracks subscriptions", async ({ state }) => {
  assert.isFalse(await state.isSubscribed("slack:C1:1"));
  await state.subscribe("slack:C1:1");
  await state.subscribe("slack:C1:1");
  assert.isTrue(await state.isSubscribed("slack:C1:1"));
  await state.unsubscribe("slack:C1:1");
  assert.isFalse(await state.isSubscribed("slack:C1:1"));
});

test("holds a lock until it is released or expires", async ({ state, advance }) => {
  const lock = await state.acquireLock("t", 100);
  assert.deepStrictEqual(lock, { threadId: "t", token: "token-1", expiresAt: 1_100 });
  assert.isNull(await state.acquireLock("t", 100));

  advance(50);
  assert.isTrue(await state.extendLock(lock!, 100));
  advance(60);
  // Extended to 1_150, so still held at 1_110.
  assert.isNull(await state.acquireLock("t", 100));

  advance(100);
  const next = await state.acquireLock("t", 100);
  assert.strictEqual(next?.token, "token-4");
  // The expired holder can neither extend nor release the new lock.
  assert.isFalse(await state.extendLock(lock!, 100));
  await state.releaseLock(lock!);
  assert.isNull(await state.acquireLock("t", 100));

  await state.releaseLock(next!);
  assert.isNotNull(await state.acquireLock("t", 100));
  await state.forceReleaseLock("t");
  assert.isNotNull(await state.acquireLock("t", 100));
});

test("sets a key only when it is absent or expired", async ({ state, advance }) => {
  assert.isTrue(await state.setIfNotExists("dedupe:e1", true, 1_000));
  assert.isFalse(await state.setIfNotExists("dedupe:e1", true, 1_000));
  assert.strictEqual(await state.get("dedupe:e1"), true);

  advance(1_000);
  assert.isNull(await state.get("dedupe:e1"));
  assert.isTrue(await state.setIfNotExists("dedupe:e1", "again", 1_000));
  assert.strictEqual(await state.get("dedupe:e1"), "again");

  await state.set("plain", { a: 1 });
  assert.isFalse(await state.setIfNotExists("plain", { a: 2 }));
  assert.deepStrictEqual(await state.get("plain"), { a: 1 });
  await state.delete("plain");
  assert.isNull(await state.get("plain"));
});

test("keeps the newest list entries", async ({ state, advance }) => {
  for (const value of [1, 2, 3, 4]) {
    await state.appendToList("history", value, { maxLength: 3, ttlMs: 500 });
  }
  assert.deepStrictEqual(await state.getList("history"), [2, 3, 4]);
  advance(500);
  assert.deepStrictEqual(await state.getList("history"), []);
});

test("queues messages in order, dropping the oldest past the cap and expired ones", async ({
  state,
  advance,
}) => {
  const entry = (id: string, expiresAt: number) => ({
    enqueuedAt: 1_000,
    expiresAt,
    message: { id } as never,
  });
  assert.strictEqual(await state.enqueue("t", entry("m1", 5_000), 2), 1);
  assert.strictEqual(await state.enqueue("t", entry("m2", 1_200), 2), 2);
  assert.strictEqual(await state.enqueue("t", entry("m3", 5_000), 2), 2);
  assert.strictEqual(await state.queueDepth("t"), 2);

  advance(500);
  // m1 fell off the cap and m2 has expired.
  assert.strictEqual(await state.queueDepth("t"), 1);
  const next = await state.dequeue("t");
  assert.deepStrictEqual(next?.message, { id: "m3" } as never);
  assert.isNull(await state.dequeue("t"));
});
