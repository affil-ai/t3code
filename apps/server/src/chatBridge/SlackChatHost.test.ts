// @effect-diagnostics nodeBuiltinImport:off - Signs recorded Slack payloads the way Slack does.
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { ChatInboundEvent } from "./ChatBridgeCore.ts";
import * as SlackChatHost from "./SlackChatHost.ts";
import * as SqliteChatState from "./SqliteChatState.ts";

const SIGNING_SECRET = "test-signing-secret";

/** A recorded `app_mention` delivery, trimmed to the fields the adapter reads. */
const appMention = (eventId: string, text: string, user = "U0ALLOWED") => ({
  token: "unused",
  team_id: "T0TEAM",
  api_app_id: "A0APP",
  type: "event_callback",
  event_id: eventId,
  event_time: 1_700_000_000,
  authorizations: [{ user_id: "U0BOT", is_bot: true }],
  event: {
    type: "app_mention",
    user,
    text,
    ts: "1700000000.000100",
    channel: "C0MAPPED",
    event_ts: "1700000000.000100",
  },
});

const signed = (body: string, nowMs: number, secret = SIGNING_SECRET) => {
  const timestamp = Math.floor(nowMs / 1000).toString();
  const signature = `v0=${NodeCrypto.createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("http://chat-bridge.local/chat-slack", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body,
  });
};

/** A webhook-mode host whose Slack Web API calls go nowhere. */
const startHost = Effect.gen(function* () {
  const state = yield* SqliteChatState.make({
    now: () => 0,
    randomToken: Effect.succeed("token"),
  });
  const events: Array<ChatInboundEvent> = [];
  let delivered: () => void = () => {};
  const nextEvent = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  const host = yield* Effect.promise(() =>
    SlackChatHost.startSlackChatHost({
      transport: "webhook",
      botToken: "xoxb-test",
      signingSecret: SIGNING_SECRET,
      state,
      apiUrl: "http://127.0.0.1:9/",
      onEvent: async (event) => {
        events.push(event);
        delivered();
        return { type: "ignored", reason: "unmapped_channel" };
      },
      onError: () => {},
    }),
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => host.shutdown()));
  return { host, events, nextEvent };
});

const live = <A, E>(name: string, effect: Effect.Effect<A, E, never>) =>
  it.live(name, () => effect);
const withHost = <A, E>(
  body: (harness: Effect.Success<typeof startHost>, nowMs: number) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const harness = yield* startHost;
    return yield* body(harness, yield* Clock.currentTimeMillis);
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

live(
  "rejects a request signed with another secret",
  withHost(({ host, events }, now) =>
    Effect.promise(async () => {
      const body = JSON.stringify(appMention("Ev1", "<@U0BOT> hello"));
      const response = await host.handleWebhook(signed(body, now, "wrong-secret"));
      assert.strictEqual(response.status, 401);
      assert.deepStrictEqual(events, []);
    }),
  ),
);

live(
  "rejects a replayed request older than Slack's five-minute window",
  withHost(({ host }, now) =>
    Effect.promise(async () => {
      const body = JSON.stringify(appMention("Ev1", "<@U0BOT> hello"));
      const response = await host.handleWebhook(signed(body, now - 10 * 60 * 1000));
      assert.strictEqual(response.status, 401);
    }),
  ),
);

live(
  "answers Slack's URL verification",
  withHost(({ host }, now) =>
    Effect.promise(async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "challenge-value" });
      const response = await host.handleWebhook(signed(body, now));
      assert.strictEqual(response.status, 200);
      assert.include(await response.text(), "challenge-value");
    }),
  ),
);

live(
  "turns a signed mention into an inbound event",
  withHost(({ host, events, nextEvent }, now) =>
    Effect.promise(async () => {
      const body = JSON.stringify(appMention("Ev1", "<@U0BOT> fix the flaky test"));
      const response = await host.handleWebhook(signed(body, now));
      assert.strictEqual(response.status, 200);
      await nextEvent;
      assert.strictEqual(events.length, 1);
      const [event] = events;
      assert.strictEqual(event?.kind, "mention");
      assert.strictEqual(event?.chatThreadKey, "slack:C0MAPPED:1700000000.000100");
      assert.strictEqual(event?.channelId, "C0MAPPED");
      assert.strictEqual(event?.author.userId, "U0ALLOWED");
      assert.strictEqual(event?.eventId, "slack:C0MAPPED:1700000000.000100");
      assert.include(event?.text ?? "", "fix the flaky test");
    }),
  ),
);

it("strips only the leading bot mention", () => {
  assert.strictEqual(SlackChatHost.stripBotMention("@t3 fix it", "t3"), "fix it");
  assert.strictEqual(SlackChatHost.stripBotMention("@T3: fix it", "t3"), "fix it");
  assert.strictEqual(SlackChatHost.stripBotMention("ask @t3 later", "t3"), "ask @t3 later");
  assert.strictEqual(SlackChatHost.stripBotMention("@t3bot hi", "t3"), "@t3bot hi");
  assert.strictEqual(SlackChatHost.stripBotMention("  hi  ", undefined), "hi");
});

it("maps a Chat SDK message to an inbound event", () => {
  const event = SlackChatHost.toInboundEvent(
    { id: "slack:C0MAPPED:1700000000.000100" },
    {
      id: "1700000000.000200",
      text: "@t3 also the lint",
      author: { userId: "U1", userName: "ada", fullName: "Ada", isBot: false, isMe: false },
      attachments: [{ type: "file", name: "trace.log" }, { type: "image" }],
    },
    "follow_up",
    "t3",
  );
  assert.deepStrictEqual(event, {
    eventId: "slack:C0MAPPED:1700000000.000200",
    platform: "slack",
    chatThreadKey: "slack:C0MAPPED:1700000000.000100",
    channelId: "C0MAPPED",
    kind: "follow_up",
    author: { userId: "U1", userName: "ada", fullName: "Ada" },
    text: "also the lint",
    fileNames: ["trace.log", "image"],
  });
});
