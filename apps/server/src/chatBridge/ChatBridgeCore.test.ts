import { assert, it } from "@effect/vitest";
import {
  type ChatAttachment,
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
      readonly op: "send";
      readonly commandId: string;
      readonly threadId: string;
      readonly text: string;
      readonly mode: "steer" | "queue";
      readonly attachments: ReadonlyArray<ChatAttachment>;
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
  files: [],
  mentions: [],
  ...overrides,
});

const imported: ChatAttachment = {
  type: "file",
  id: "pending-file-1",
  name: "trace.log",
  mimeType: "text/plain",
  sizeBytes: 3,
};

function harness(
  config: ChatBridgeSlackConfig,
  answer: Option.Option<string> = Option.some("Done."),
  /** The run a follow-up lands in; a steer joins the run in flight. */
  sentTo: { readonly runId: string; readonly delivery: "started" | "queued" | "steered" } = {
    runId: "run-2",
    delivery: "steered",
  },
) {
  return Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const threads = Layer.succeed(ChatBridgeCore.ChatThreads)({
      start: ({ attachments: _attachments, ...input }) =>
        Ref.update(calls, (all) => [...all, { op: "start" as const, ...input }]).pipe(
          Effect.as(ThreadId.make("thread-1")),
        ),
      send: (input) =>
        Ref.update(calls, (all) => [
          ...all,
          {
            op: "send" as const,
            commandId: input.commandId,
            threadId: input.threadId,
            text: input.text,
            mode: input.mode,
            attachments: input.attachments,
          },
        ]).pipe(Effect.as({ runId: RunId.make(sentTo.runId), delivery: sentTo.delivery })),
      // A file named `broken` fails to download; the rest import.
      importFiles: (files) =>
        Effect.succeed({
          attachments: files.filter((file) => file.name !== "broken").map(() => imported),
          skipped: files
            .filter((file) => file.name === "broken")
            .map((file) => ({ name: file.name, reason: "download failed" })),
        }),
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

it.effect("starts a thread for a mention and steers follow-ups into it", () =>
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
      assert.deepStrictEqual(followUp, {
        type: "followed_up",
        threadId: ThreadId.make("thread-1"),
        delivery: "steered",
      });

      const [start, send] = yield* Ref.get(calls);
      assert.strictEqual(start?.op, "start");
      assert.deepInclude(start, {
        commandId: "chat-bridge:slack:C0MAPPED:1700000000.000100",
        messageId: "chat-bridge:slack:C0MAPPED:1700000000.000100",
        projectId,
        title: "Fix the flaky test",
      });
      assert.isTrue(
        start?.text.startsWith(
          "Slack message from Ada Lovelace (<@U0ALLOWED>):\n\nFix the flaky test\nmore detail",
        ),
      );
      // Only the first turn explains how answers reach Slack.
      assert.include(start?.text ?? "", "chat_post");
      assert.deepInclude(send, { op: "send", threadId: "thread-1", mode: "steer" });
      assert.notInclude(send?.text ?? "", "chat_post");
    }),
  ),
);

it.effect("queues follow-ups when the settings ask for it", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core, calls } = yield* harness(
        { ...enabled, followUpMode: "queue" },
        Option.some("Done."),
        { runId: "run-2", delivery: "queued" },
      );
      yield* core.receive(mention());
      const followUp = yield* core.receive(
        mention({ kind: "follow_up", eventId: "slack:C0MAPPED:1700000000.000200" }),
      );
      assert.deepInclude(followUp, { type: "followed_up", delivery: "queued" });
      const [, send] = yield* Ref.get(calls);
      assert.deepInclude(send, { op: "send", mode: "queue" });
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

it.effect("imports attached files and names the ones it could not", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core, calls } = yield* harness(enabled);
      const file = (name: string): ChatBridgeCore.ChatInboundFile => ({
        name,
        mimeType: "text/plain",
        sizeBytes: 3,
        fetch: undefined,
      });
      yield* core.receive(mention());
      yield* core.receive(
        mention({
          kind: "follow_up",
          eventId: "slack:C0MAPPED:1700000000.000200",
          files: [file("trace.log"), file("broken")],
        }),
      );
      const [, send] = yield* Ref.get(calls);
      assert.deepStrictEqual(send?.op === "send" ? send.attachments : null, [imported]);
      assert.include(
        send?.text ?? "",
        "Attached in Slack but not imported: broken (download failed)",
      );
    }),
  ),
);

it.effect("gives the agent the ids of the people a message mentions", () =>
  Effect.sync(() => {
    const text = ChatBridgeCore.turnText(
      mention({ mentions: [{ userId: "U0GRACE", name: "Grace Hopper" }] }),
      [],
      false,
    );
    assert.include(text, "Mentioned: Grace Hopper (<@U0GRACE>)");
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

it.effect("stays quiet when a completed run has no answer, and reports failed runs", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core } = yield* harness(enabled, Option.none());
      yield* core.receive(mention());
      const text = (status: OrchestrationV2Run["status"], id: string) =>
        core
          .claimReply(run({ id: RunId.make(id), status }))
          .pipe(Effect.map(Option.map((reply) => reply.text)));
      // A completed run with no final message stays quiet in the chat.
      assert.deepStrictEqual(yield* text("completed", "run-a"), Option.none());
      assert.deepStrictEqual(
        yield* text("failed", "run-b"),
        Option.some("The run failed. Open the thread in T3 Code for details."),
      );
      assert.deepStrictEqual(yield* text("running", "run-c"), Option.none());
    }),
  ),
);

it.effect("answers a run started in T3 that a chat follow-up steered", () =>
  withDatabase(
    Effect.gen(function* () {
      const { core } = yield* harness(enabled, Option.some("Done."), {
        runId: "run-from-app",
        delivery: "steered",
      });
      yield* core.receive(mention());
      yield* core.receive(
        mention({ kind: "follow_up", eventId: "slack:C0MAPPED:1700000000.000200" }),
      );
      const steered = run({
        id: RunId.make("run-from-app"),
        userMessageId: MessageId.make("message-from-the-app"),
      });
      assert.deepInclude(Option.getOrNull(yield* core.claimReply(steered)), { text: "Done." });
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
