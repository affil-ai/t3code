import * as NodeSqlite from "node:sqlite";

import { assert, it } from "vite-plus/test";

import { Bridge, type InboundEvent, type Reply } from "./bridge.ts";
import { BridgeStore, ensureSchema } from "./store.ts";
import type { T3Tools } from "./t3Client.ts";
import { type RunStatus, T3Threads } from "./threads.ts";

const PROJECT = "project-1";
const THREAD = "thread-1";

/** A T3 server stand-in. Runs end when the test calls `finish`. */
function fakeT3() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const answers = new Map<string, string>();
  const ended = new Map<string, { status: RunStatus; resolve: () => void; done: Promise<void> }>();
  let runs = 0;
  const run = (runId: string) => {
    let entry = ended.get(runId);
    if (entry === undefined) {
      let resolve = () => {};
      const done = new Promise<void>((each) => (resolve = each));
      entry = { status: "running", resolve, done };
      ended.set(runId, entry);
    }
    return entry;
  };
  const tools: T3Tools = {
    upload: async () => {},
    call: async <T>(tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      const result = (() => {
        switch (tool) {
          case "t3_thread_launch":
            return { threadId: THREAD, runId: `run-${++runs}` };
          case "t3_thread_send":
            if (args.mode === "steer") throw new Error("steer fails when no run is in flight");
            return {
              runId: args.mode === "queue" ? `run-${++runs}` : `run-${runs}`,
              delivery: "steered",
            };
          case "t3_thread_wait":
            return run(String(args.runId)).done.then(() => ({
              runId: args.runId,
              status: run(String(args.runId)).status,
              timedOut: false,
            }));
          case "t3_thread_read": {
            if (args.itemId !== undefined) {
              const runId = String(args.itemId).replace("item-", "");
              return { thread: {}, items: [{ itemId: args.itemId, text: answers.get(runId) }] };
            }
            const items = [...answers.keys()].map((runId, position) => ({
              position,
              itemId: `item-${runId}`,
              type: "assistant_message",
              runId,
              text: "x",
            }));
            return { thread: {}, items, nextPosition: null, hasMore: false };
          }
          default:
            throw new Error(`unexpected ${tool}`);
        }
      })();
      return (await result) as T;
    },
  };
  return {
    tools,
    calls,
    finish: (runId: string, status: RunStatus, answer?: string) => {
      if (answer !== undefined) answers.set(runId, answer);
      const entry = run(runId);
      entry.status = status;
      entry.resolve();
    },
  };
}

function freshDatabase(): NodeSqlite.DatabaseSync {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  ensureSchema(db);
  return db;
}

function harness(db = freshDatabase()) {
  const t3 = fakeT3();
  const posted: Array<Reply> = [];
  const store = new BridgeStore(db);
  const bridge = new Bridge({
    store,
    threads: new T3Threads(t3.tools),
    settings: {
      channelProjects: [{ channelId: "C1", projectId: PROJECT }],
      allowedUserIds: ["U1"],
      followUpMode: "steer",
    },
    post: async (reply) => void posted.push(reply),
    sleep: async () => {},
  });
  return { t3, bridge, store, posted, db };
}

const event = (ts: string, overrides: Partial<InboundEvent> = {}): InboundEvent => ({
  eventId: `slack:C1:${ts}`,
  chatThreadKey: "slack:C1:100.1",
  channelId: "C1",
  messageId: ts,
  kind: "mention",
  author: { userId: "U1", userName: "ada", fullName: "Ada" },
  text: "fix the build",
  files: [],
  mentions: [],
  ...overrides,
});

it("starts a thread on a mention and posts its final answer", async () => {
  const { t3, bridge, store, posted } = harness();
  assert.deepStrictEqual(await bridge.receive(event("100.1")), {
    type: "started",
    threadId: THREAD,
  });

  const launch = t3.calls.find((call) => call.tool === "t3_thread_launch")!;
  assert.strictEqual(launch.args.projectId, PROJECT);
  assert.strictEqual(launch.args.clientRequestId, "chat-bridge:slack:C1:100.1");
  const chatKey = store.binding("slack:C1:100.1")!.chatKey;
  assert.include(String(launch.args.message), "Slack message 100.1 from Ada (<@U1>):");
  assert.include(String(launch.args.message), `chatKey "${chatKey}"`);

  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  assert.deepStrictEqual(posted, [{ chatThreadKey: "slack:C1:100.1", text: "Fixed." }]);
});

it("steers follow-ups into the bound thread and answers each run once", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  const followUp = await bridge.receive(event("100.2", { kind: "follow_up", text: "also lint" }));
  assert.deepStrictEqual(followUp, { type: "followed_up", threadId: THREAD, delivery: "steered" });
  const send = t3.calls.find((call) => call.tool === "t3_thread_send")!;
  assert.strictEqual(send.args.mode, "auto");
  assert.include(String(send.args.message), "also lint");

  t3.finish("run-1", "completed", "Both done.");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Both done."],
  );
});

it("ignores strangers, unmapped channels, unbound follow-ups and redeliveries", async () => {
  const { t3, bridge } = harness();
  const stranger = event("100.1", { author: { userId: "U9", userName: "x", fullName: "X" } });
  assert.deepStrictEqual(await bridge.receive(stranger), {
    type: "ignored",
    reason: "not_allowed",
  });
  const elsewhere = event("200.1", { channelId: "C2", chatThreadKey: "slack:C2:200.1" });
  assert.deepStrictEqual(await bridge.receive(elsewhere), {
    type: "ignored",
    reason: "unmapped_channel",
  });
  assert.deepStrictEqual(await bridge.receive(event("100.5", { kind: "follow_up" })), {
    type: "ignored",
    reason: "unbound_thread",
  });
  await bridge.receive(event("100.1"));
  assert.deepStrictEqual(await bridge.receive(event("100.1")), {
    type: "ignored",
    reason: "duplicate",
  });
  assert.lengthOf(
    t3.calls.filter((call) => call.tool === "t3_thread_launch"),
    1,
  );
});

it("stays quiet when a completed run has no answer", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed");
  await bridge.idle();
  assert.deepStrictEqual(posted, []);

  await bridge.receive(event("100.2", { kind: "follow_up" }));
  // Steering into an ended run: the fake reuses run-1, which already answered.
  await bridge.idle();
  assert.deepStrictEqual(posted, []);
});

it("posts a failure notice when a run fails", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "failed");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["The run failed. Open the thread in T3 Code for details."],
  );
});

it("resumes owed replies after a restart", async () => {
  const db = freshDatabase();
  const first = harness(db);
  await first.bridge.receive(event("100.1"));
  first.bridge.stop();

  const second = harness(db);
  second.bridge.resume();
  second.t3.finish("run-1", "completed", "Done after restart.");
  await second.bridge.idle();
  assert.deepStrictEqual(
    second.posted.map((reply) => reply.text),
    ["Done after restart."],
  );
});
