import { assert, it } from "vite-plus/test";

import {
  connectSlackRelay,
  RELAY_CONCURRENCY,
  RELAY_MAX_ATTEMPTS,
  type SlackInboxRow,
  type SlackRelaySource,
  type SlackWebhookHandler,
} from "./relay.ts";

const row = (id: string): SlackInboxRow => ({
  id,
  kind: "event",
  rawBody: JSON.stringify({ type: "event_callback", event_id: id }),
  contentType: "application/json",
  retryNum: 0,
});

function fakeOffice() {
  let push: ((rows: ReadonlyArray<SlackInboxRow>) => void) | undefined;
  const delivered: Array<ReadonlyArray<string>> = [];
  const waiters: Array<{ id: string; resolve: () => void }> = [];
  const source: SlackRelaySource = {
    subscribeSlackInbox: (onRows) => {
      push = onRows;
      return () => {
        push = undefined;
      };
    },
    slackDelivered: async (ids) => {
      delivered.push(ids);
      for (const waiter of waiters.filter((each) => ids.includes(each.id))) waiter.resolve();
    },
  };
  return {
    source,
    delivered,
    subscribed: () => push !== undefined,
    push: (rows: ReadonlyArray<SlackInboxRow>) => push?.(rows),
    /** Resolves when `id` is marked delivered. */
    deliveredOf: (id: string) => new Promise<void>((resolve) => void waiters.push({ id, resolve })),
  };
}

it("gives up on a row that keeps failing after three tries and marks it delivered", async () => {
  const office = fakeOffice();
  const tries = new Map<string, number>();
  const logs: Array<string> = [];
  const handler: SlackWebhookHandler = async (request, options) => {
    const body = (await request.json()) as { event_id: string };
    tries.set(body.event_id, (tries.get(body.event_id) ?? 0) + 1);
    if (body.event_id === "bad") {
      // Work the handler hands off fails, as a broken Chat SDK step would.
      options.waitUntil(Promise.reject(new Error("broken")));
    }
    return new Response("ok");
  };
  const relay = connectSlackRelay({
    transport: "office-relay",
    source: office.source,
    chat: { webhooks: { slack: handler } },
    log: (line) => void logs.push(line),
    sleep: async () => {},
    timeout: () => new Promise<void>(() => {}),
  })!;
  office.push([row("bad"), row("good")]);
  await relay.idle();
  assert.strictEqual(tries.get("bad"), RELAY_MAX_ATTEMPTS);
  assert.strictEqual(tries.get("good"), 1);
  // "good" doesn't wait for "bad"'s retries; both end up delivered.
  assert.deepStrictEqual(office.delivered.flat().toSorted(), ["bad", "good"]);
  assert.isTrue(logs.some((line) => line.includes("giving up on event bad")));
  // Logs name the row, never its body.
  assert.isFalse(logs.some((line) => line.includes("event_callback")));

  // A snapshot from before the delivery doesn't replay the rows.
  office.push([row("bad"), row("good")]);
  await relay.idle();
  assert.strictEqual(tries.get("good"), 1);
  await relay.close();
});

it("doesn't subscribe to the relay in Socket Mode", () => {
  const office = fakeOffice();
  const relay = connectSlackRelay({
    transport: "socket",
    source: office.source,
    chat: { webhooks: { slack: async () => new Response("ok") } },
    log: () => {},
  });
  assert.isUndefined(relay);
  assert.isFalse(office.subscribed());
});

it("handles other rows while one hangs, and retries the hung one when it times out", async () => {
  const office = fakeOffice();
  const tries = new Map<string, number>();
  const handler: SlackWebhookHandler = async (request, options) => {
    const body = (await request.json()) as { event_id: string };
    const count = (tries.get(body.event_id) ?? 0) + 1;
    tries.set(body.event_id, count);
    // The first try of "slow" hands off work that never settles, like a hung T3 hand-off.
    if (body.event_id === "slow" && count === 1) options.waitUntil(new Promise(() => {}));
    return new Response("ok");
  };
  const timers: Array<() => void> = [];
  const relay = connectSlackRelay({
    transport: "office-relay",
    source: office.source,
    chat: { webhooks: { slack: handler } },
    log: () => {},
    sleep: async () => {},
    timeout: () => new Promise<void>((resolve) => void timers.push(resolve)),
  })!;

  const fastDelivered = office.deliveredOf("fast");
  office.push([row("slow"), row("fast")]);
  await fastDelivered;
  assert.deepStrictEqual(office.delivered.flat(), ["fast"]);

  // The hung try times out, counts as a failure, and the retry goes through.
  const slowDelivered = office.deliveredOf("slow");
  for (const fire of timers.splice(0)) fire();
  await slowDelivered;
  await relay.idle();
  assert.strictEqual(tries.get("slow"), 2);
  assert.strictEqual(tries.get("fast"), 1);
  assert.deepStrictEqual(office.delivered.flat().toSorted(), ["fast", "slow"]);
  await relay.close();
});

it("runs at most RELAY_CONCURRENCY rows at once", async () => {
  const office = fakeOffice();
  let running = 0;
  let peak = 0;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => (openGate = resolve));
  let markFull!: () => void;
  const full = new Promise<void>((resolve) => (markFull = resolve));
  const handler: SlackWebhookHandler = async (_request, options) => {
    running++;
    peak = Math.max(peak, running);
    if (running === RELAY_CONCURRENCY) markFull();
    options.waitUntil(gate.then(() => void running--));
    return new Response("ok");
  };
  const relay = connectSlackRelay({
    transport: "office-relay",
    source: office.source,
    chat: { webhooks: { slack: handler } },
    log: () => {},
    sleep: async () => {},
    timeout: () => new Promise<void>(() => {}),
  })!;
  const rows = Array.from({ length: RELAY_CONCURRENCY + 3 }, (_, index) => row(`r${index}`));
  office.push(rows);
  await full;
  assert.strictEqual(peak, RELAY_CONCURRENCY);
  openGate();
  await relay.idle();
  assert.strictEqual(peak, RELAY_CONCURRENCY);
  assert.strictEqual(new Set(office.delivered.flat()).size, rows.length);
  await relay.close();
});
