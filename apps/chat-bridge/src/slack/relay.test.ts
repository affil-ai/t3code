import { assert, it } from "vite-plus/test";

import {
  connectSlackRelay,
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
  const source: SlackRelaySource = {
    subscribeSlackInbox: (onRows) => {
      push = onRows;
      return () => {
        push = undefined;
      };
    },
    slackDelivered: async (ids) => void delivered.push(ids),
  };
  return {
    source,
    delivered,
    subscribed: () => push !== undefined,
    push: (rows: ReadonlyArray<SlackInboxRow>) => push?.(rows),
  };
}

it("gives up on a row that keeps failing after three tries, marks it delivered, and goes on", async () => {
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
  })!;
  office.push([row("bad"), row("good")]);
  await relay.idle();
  assert.strictEqual(tries.get("bad"), RELAY_MAX_ATTEMPTS);
  assert.strictEqual(tries.get("good"), 1);
  assert.deepStrictEqual(office.delivered, [["bad", "good"]]);
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
