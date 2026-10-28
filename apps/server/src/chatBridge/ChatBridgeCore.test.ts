import { assert, it } from "@effect/vitest";
import {
  type ChatBridgeSlackConfig,
  DEFAULT_CHAT_BRIDGE_SLACK_CONFIG,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import type * as SqlClient from "effect/sql/SqlClient";

import * as ChatBindingStore from "./ChatBindingStore.ts";
import * as ChatBridgeConfigStore from "./ChatBridgeConfigStore.ts";
import * as ChatBridgeCore from "./ChatBridgeCore.ts";

const projectId = ProjectId.make("project-1");
const allowed = { userId: "U0ALLOWED", userName: "ada", fullName: "Ada Lovelace" };
const enabled: ChatBridgeSlackConfig = {
  ...DEFAULT_CHAT_BRIDGE_SLACK_CONFIG,
  enabled: true,
  channelProjects: [{ channelId: "C0MAPPED", projectId }],
  allowedUserIds: [allowed.userId],
};

type Call =
  | {
      readonly op: "start";
      readonly commandId: string;
      readonly messageId: string;
      readonly projectId: string;
      readonly title: string;
      readonly text: string;
    }
  | {
      readonly op: "queue";
      readonly commandId: string;
      readonly threadId: string;
      readonly text: string;
    };

const mention = (
  overrides: Partial<ChatBridgeCore.ChatInboundEvent> = {},
): ChatBridgeCore.ChatInboundEvent => ({
  eventId: "slack:C0MAPPED:1700000000.000100",
  platform: "slack",
  chatThreadKey: "slack:C0MAPPED:1700000000.000100",
  channelId: "C0MAPPED",
  kind: "mention",
  author: allowed,
  text: "Fix the flaky test\nmore detail",
  fileNames: [],
  ...overrides,
});

function harness(
  config: ChatBridgeSlackConfig,
  answer: Option.Option<string> = Option.some("Done."),
) {
  return Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const threads = Layer.succeed(ChatBridgeCore.ChatThreads)({
      start: (input) =>
        Ref.update(calls, (all) => [...all, { op: "start" as const, ...input }]).pipe(
          Effect.as(ThreadId.make("thread-1")),
        ),
      queue: (input) => Ref.update(calls, (all) => [...all, { op: "queue" as const, ...input }]),
      finalAnswer: () => Effect.succeed(answer),
    });
    const stores = Layer.mergeAll(ChatBindingStore.layerSqlite, ChatBridgeConfigStore.layerSqlite);
    const context = yield* Layer.build(
      ChatBridgeCore.layer.pipe(Layer.provideMerge(Layer.merge(threads, stores))),
    );
    const store = Context.get(context, ChatBridgeConfigStore.ChatBridgeConfigStore);
    yield* store.setSlack(config);
    return { core: Context.get(context, ChatBridgeCore.ChatBridgeCore), calls };
  });
}

const run = (overrides: Partial<OrchestrationV2Run>): OrchestrationV2Run => ({
  id: RunId.make("run-1"),
  threadId: ThreadId.make("thread-1"),
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  providerThreadId: null,
  userMessageId: MessageId.make("chat-bridge:slack:C0MAPPED:1700000000.000100"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: DateTime.makeUnsafe(0),
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...overrides,
});

/** Each test gets its own empty database. */
const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

it.effect("ignores everything while the bridge is off", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core, calls } = yield* harness(DEFAULT_CHAT_BRIDGE_SLACK_CONFIG);
      assert.deepStrictEqual(yield* core.receive(mention()), {
        type: "ignored",
        reason: "disabled",
      });
      assert.deepStrictEqual(yield* Ref.get(calls), []);
    }),
  ),
);

it.effect("ignores people who are not on the allowlist", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core, calls } = yield* harness(enabled);
      const stranger = { userId: "U0STRANGER", userName: "eve", fullName: "Eve" };
      assert.deepStrictEqual(yield* core.receive(mention({ author: stranger })), {
        type: "ignored",
        reason: "not_allowed",
      });
      assert.deepStrictEqual(yield* Ref.get(calls), []);
    }),
  ),
);

it.effect("ignores a mention in a channel with no project", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core } = yield* harness(enabled);
      const outcome = yield* core.receive(
        mention({
          channelId: "C0OTHER",
          chatThreadKey: "slack:C0OTHER:1.0",
          eventId: "slack:C0OTHER:1.0",
        }),
      );
      assert.deepStrictEqual(outcome, { type: "ignored", reason: "unmapped_channel" });
    }),
  ),
);

it.effect("starts a thread for a mention and queues follow-ups on it", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core, calls } = yield* harness(enabled);
      const started = yield* core.receive(mention());
      assert.deepStrictEqual(started, { type: "started", threadId: ThreadId.make("thread-1") });

      const followUp = yield* core.receive(
        mention({
          kind: "follow_up",
          eventId: "slack:C0MAPPED:1700000000.000200",
          text: "also the lint",
        }),
      );
      assert.deepStrictEqual(followUp, { type: "queued", threadId: ThreadId.make("thread-1") });

      const [start, queue] = yield* Ref.get(calls);
      assert.deepStrictEqual(start, {
        op: "start",
        commandId: "chat-bridge:slack:C0MAPPED:1700000000.000100",
        messageId: "chat-bridge:slack:C0MAPPED:1700000000.000100",
        projectId,
        title: "Fix the flaky test",
        text: "Slack message from Ada Lovelace (U0ALLOWED):\n\nFix the flaky test\nmore detail",
      });
      assert.strictEqual(queue?.op, "queue");
      assert.strictEqual(queue?.op === "queue" ? queue.threadId : null, "thread-1");
    }),
  ),
);

it.effect("ignores a follow-up in a chat thread that never started work", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core, calls } = yield* harness(enabled);
      assert.deepStrictEqual(yield* core.receive(mention({ kind: "follow_up" })), {
        type: "ignored",
        reason: "unbound_thread",
      });
      assert.deepStrictEqual(yield* Ref.get(calls), []);
    }),
  ),
);

it.effect("names attachments it did not import", () =>
  Effect.sync(() => {
    assert.include(
      ChatBridgeCore.turnText(mention({ fileNames: ["trace.log", "image/png"] })),
      "Attached in Slack but not imported: trace.log, image/png",
    );
  }),
);

it.effect("answers a finished chat run once", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core } = yield* harness(enabled);
      yield* core.receive(mention());
      const reply = yield* core.claimReply(run({}));
      assert.deepStrictEqual(
        reply,
        Option.some({
          chatThreadKey: "slack:C0MAPPED:1700000000.000100",
          runId: RunId.make("run-1"),
          text: "Done.",
        }),
      );
      assert.deepStrictEqual(yield* core.claimReply(run({})), Option.none());

      // A released claim is owed again, so a failed post can be retried.
      yield* core.releaseReply(RunId.make("run-1"));
      assert.isTrue(Option.isSome(yield* core.claimReply(run({}))));
    }),
  ),
);

it.effect("reports runs that end without an answer", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core } = yield* harness(enabled, Option.none());
      yield* core.receive(mention());
      const text = (status: OrchestrationV2Run["status"], id: string) =>
        core
          .claimReply(run({ id: RunId.make(id), status }))
          .pipe(Effect.map(Option.map((reply) => reply.text)));
      assert.deepStrictEqual(
        yield* text("completed", "run-a"),
        Option.some("The run finished without a reply."),
      );
      assert.deepStrictEqual(
        yield* text("failed", "run-b"),
        Option.some("The run failed. Open the thread in T3 Code for details."),
      );
      assert.deepStrictEqual(yield* text("running", "run-c"), Option.none());
    }),
  ),
);

it.effect("does not answer runs the bridge did not start", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core } = yield* harness(enabled);
      yield* core.receive(mention());
      const fromApp = run({ userMessageId: MessageId.make("message-from-the-app") });
      assert.deepStrictEqual(yield* core.claimReply(fromApp), Option.none());
    }),
  ),
);
