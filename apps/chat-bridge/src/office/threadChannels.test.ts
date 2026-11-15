// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
import * as NodeSqlite from "node:sqlite";

import { assert, it } from "vite-plus/test";

import { BridgeStore, ensureSchema, type Binding } from "../store.ts";
import {
  createThreadChannelReporter,
  THREAD_CHANNELS_CURSOR_KEY,
  type ThreadChannelBinding,
  type Timer,
} from "./threadChannels.ts";

const ENV = "env-1";

const freshStore = (clock: { now: number }) => {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  ensureSchema(db);
  return new BridgeStore(db, () => clock.now);
};

const binding = (chatThreadKey: string, threadId: string): Binding => ({
  chatThreadKey,
  channelId: chatThreadKey.split(":")[1] ?? "",
  projectId: "project",
  threadId,
  chatKey: `key-${threadId}-${chatThreadKey}`,
  createdByUserId: "U1",
});

/** Runs what the reporter scheduled, and waits for it, instead of waiting on the clock. */
const manualTimer = () => {
  let queued: Array<() => unknown> = [];
  const timer: Timer = {
    set: (run) => {
      queued.push(run);
      return { cancel: () => (queued = queued.filter((each) => each !== run)) };
    },
  };
  const fire = async () => {
    const due = queued;
    queued = [];
    await Promise.all(due.map((run) => run()));
  };
  return { timer, fire, pending: () => queued.length };
};

it("reports a new Slack binding after it is saved, with its thread and when it was bound", async () => {
  const clock = { now: 1_000 };
  const store = freshStore(clock);
  const sent: ThreadChannelBinding[][] = [];
  const clockwork = manualTimer();
  const reporter = createThreadChannelReporter({
    store,
    send: async (bindings) => void sent.push([...bindings]),
    environmentId: ENV,
    log: () => {},
    timer: clockwork.timer,
  });
  store.onBindingSaved = reporter.notify;
  store.transaction(() => {
    store.insertBinding(binding("slack:C0123ABC:1794278854.319499", "thread-1"));
    // Nothing is sent inside the transaction.
    assert.lengthOf(sent, 0);
  });
  assert.equal(clockwork.pending(), 1);
  await clockwork.fire();
  assert.deepEqual(sent, [
    [
      {
        environmentId: ENV,
        threadId: "thread-1",
        boundAt: 1_000,
        slack: { channelId: "C0123ABC", threadTs: "1794278854.319499" },
      },
    ],
  ]);
  // A second save of the same conversation is not a new binding.
  store.insertBinding(binding("slack:C0123ABC:1794278854.319499", "thread-1"));
  assert.equal(clockwork.pending(), 0);
  assert.lengthOf(sent, 1);
  reporter.stop();
});

it("sends Linear bindings with their issue URL and leaves out iMessage and Office chats", async () => {
  const clock = { now: 5 };
  const store = freshStore(clock);
  store.insertBinding(binding("imessage:42", "thread-i"));
  store.insertBinding(binding("office:chat-1", "thread-o"));
  store.insertBinding(binding("linear:issue-uuid", "thread-l"));
  const sent: ThreadChannelBinding[] = [];
  const reporter = createThreadChannelReporter({
    store,
    send: async (bindings) => void sent.push(...bindings),
    environmentId: ENV,
    linearIssueUrl: async (id) =>
      id === "issue-uuid" ? "https://linear.app/affil/issue/ENG-12/title" : undefined,
    log: () => {},
  });
  assert.deepEqual(await reporter.sync(), { sent: 1 });
  assert.deepEqual(sent, [
    {
      environmentId: ENV,
      threadId: "thread-l",
      boundAt: 5,
      linear: { issueUrl: "https://linear.app/affil/issue/ENG-12/title" },
    },
  ]);
});

it("a failing report never fails the chat's binding, logs no conversation, and retries", async () => {
  const clock = { now: 10 };
  const store = freshStore(clock);
  const logs: string[] = [];
  let failing = true;
  const sent: ThreadChannelBinding[] = [];
  const clockwork = manualTimer();
  const reporter = createThreadChannelReporter({
    store,
    timer: clockwork.timer,
    send: async (bindings) => {
      if (failing) throw new Error("Office bindThreadChannels failed.");
      sent.push(...bindings);
    },
    environmentId: ENV,
    log: (line) => logs.push(line),
  });
  store.onBindingSaved = () => {
    reporter.notify();
    throw new Error("a broken hook must not fail the save either");
  };
  const key = "slack:C0123ABC:1794278854.319499";
  store.transaction(() => store.insertBinding(binding(key, "thread-1")));
  assert.equal(store.binding(key)?.threadId, "thread-1");
  await clockwork.fire();
  assert.lengthOf(sent, 0);
  assert.isTrue(logs.some((line) => line.includes("failed")));
  assert.isFalse(logs.some((line) => line.includes("C0123ABC") || line.includes("1794278854")));
  assert.isUndefined(store.meta(THREAD_CHANNELS_CURSOR_KEY));
  // The failure scheduled a retry.
  assert.equal(clockwork.pending(), 1);
  failing = false;
  await clockwork.fire();
  assert.lengthOf(sent, 1);
  assert.equal(store.meta(THREAD_CHANNELS_CURSOR_KEY), "10");
  reporter.stop();
});

it("backfills every binding once, in batches of 200, and a rerun sends only what is new", async () => {
  const clock = { now: 1 };
  const store = freshStore(clock);
  for (let index = 0; index < 250; index++) {
    clock.now = 100 + index;
    store.insertBinding(
      binding(`slack:C0123ABC:1794278854.${String(index).padStart(6, "0")}`, `t-${index}`),
    );
  }
  const calls: number[] = [];
  const reporter = createThreadChannelReporter({
    store,
    send: async (bindings) => void calls.push(bindings.length),
    environmentId: ENV,
    log: () => {},
  });
  assert.deepEqual(await reporter.sync(), { sent: 250 });
  assert.deepEqual(calls, [200, 50]);
  assert.equal(store.meta(THREAD_CHANNELS_CURSOR_KEY), "349");
  // A restart runs the same step again: only the last one, resent idempotently.
  calls.length = 0;
  const restarted = createThreadChannelReporter({
    store,
    send: async (bindings) => void calls.push(bindings.length),
    environmentId: ENV,
    log: () => {},
  });
  assert.deepEqual(await restarted.sync(), { sent: 1 });
  clock.now = 400;
  store.insertBinding(binding("slack:C0123ABC:1794278999.000001", "t-new"));
  // The new one, plus the one at the cursor again; Office leaves a stored pairing as it is.
  assert.deepEqual(await restarted.sync(), { sent: 2 });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(store.meta(THREAD_CHANNELS_CURSOR_KEY), "400");
});
