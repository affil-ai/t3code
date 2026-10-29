/**
 * Runs the chat bridge: holds the Slack host for the current settings and
 * secrets, restarts it when either changes, posts each finished chat run's
 * answer, and serves the settings RPCs.
 */
import {
  type ChatBridgeConnectionState,
  ChatBridgeError,
  type ChatBridgeSetSlackSecretInput,
  type ChatBridgeSlackConfig,
  type ChatBridgeSlackSecretName,
  type ChatBridgeStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { timingSafeEqualBase64Url } from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ScheduledTaskWebhookOrigin } from "../scheduledTasks/ScheduledTaskService.ts";
import * as ChatBindingStore from "./ChatBindingStore.ts";
import * as ChatBridgeConfigStore from "./ChatBridgeConfigStore.ts";
import * as ChatBridgeCore from "./ChatBridgeCore.ts";
import * as SlackChatHost from "./SlackChatHost.ts";
import * as SqliteChatState from "./SqliteChatState.ts";
import { slackAppManifest } from "./slackManifest.ts";

/** The reserved id under `/api/hooks/` that carries Slack's Events API. */
export const SLACK_HOOK_ID = "chat-slack";

const SECRET_NAMES: Record<ChatBridgeSlackSecretName, string> = {
  botToken: "chat-bridge-slack-bot-token",
  signingSecret: "chat-bridge-slack-signing-secret",
  appToken: "chat-bridge-slack-app-token",
};
const HOOK_TOKEN_SECRET = "chat-bridge-slack-hook-token";

export class ChatBridgeService extends Context.Service<
  ChatBridgeService,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly getStatus: () => Effect.Effect<ChatBridgeStatus, ChatBridgeError>;
    readonly updateSlackConfig: (
      config: ChatBridgeSlackConfig,
    ) => Effect.Effect<ChatBridgeStatus, ChatBridgeError>;
    readonly setSlackSecret: (
      input: ChatBridgeSetSlackSecretInput,
    ) => Effect.Effect<ChatBridgeStatus, ChatBridgeError>;
    /**
     * Posts to the chat thread bound to a T3 thread, for its agent's
     * `chat_post` tool. None when the thread answers no chat thread.
     */
    readonly postFromThread: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
      readonly files: ReadonlyArray<SlackChatHost.SlackOutboundFile>;
    }) => Effect.Effect<Option.Option<{ readonly chatThreadKey: string }>, ChatBridgeError>;
    /** None when the token does not match, so the route answers 404 like any unknown hook. */
    readonly handleSlackHook: (
      token: string,
      request: Request,
    ) => Effect.Effect<Option.Option<Response>>;
  }
>()("t3/chatBridge/ChatBridgeService") {}

const bridgeError = (message: string) => (cause: unknown) =>
  new ChatBridgeError({ message, cause });

export const make = Effect.gen(function* () {
  const core = yield* ChatBridgeCore.ChatBridgeCore;
  const bindings = yield* ChatBindingStore.ChatBindingStore;
  const configStore = yield* ChatBridgeConfigStore.ChatBridgeConfigStore;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const webhookOrigin = yield* ScheduledTaskWebhookOrigin;
  const clock = yield* Clock.Clock;
  const crypto = yield* Crypto.Crypto;
  const state = yield* SqliteChatState.make({
    now: () => clock.currentTimeMillisUnsafe(),
    randomToken: crypto.randomUUIDv4().pipe(Effect.orDie),
  });
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);

  const host = yield* Ref.make<SlackChatHost.SlackChatHost | null>(null);
  const connection = yield* Ref.make<{
    readonly state: ChatBridgeConnectionState;
    readonly error: string | null;
  }>({ state: "off", error: null });
  const lifecycle = yield* Semaphore.make(1);

  const readSecret = (name: ChatBridgeSlackSecretName) =>
    secrets
      .get(SECRET_NAMES[name])
      .pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
        Effect.mapError(bridgeError("Could not read a Slack secret.")),
      );

  const hookToken = secrets.getOrCreateRandom(HOOK_TOKEN_SECRET, 32).pipe(
    Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
    Effect.mapError(bridgeError("Could not read the Slack hook token.")),
  );

  const webhookUrl = Effect.gen(function* () {
    const origin = yield* webhookOrigin;
    if (origin.relayHookBaseUrl === null) return null;
    return `${origin.relayHookBaseUrl}/${SLACK_HOOK_ID}/${yield* hookToken}`;
  });

  const logFailure = (message: string) => (error: unknown) =>
    void runPromise(Effect.logWarning(message, { error: String(error) }));

  const stopHost = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(host, null);
    if (current !== null) {
      yield* Effect.promise(() =>
        current.shutdown().catch(logFailure("Slack host shutdown failed")),
      );
    }
  });

  /** Stops the running host and starts one for the current settings, if they allow it. */
  const reload = lifecycle.withPermits(1)(
    Effect.gen(function* () {
      yield* stopHost;
      const config = yield* configStore.slack.pipe(
        Effect.mapError(bridgeError("Could not read settings.")),
      );
      if (!config.enabled) {
        yield* Ref.set(connection, { state: "off", error: null });
        return;
      }
      const botToken = yield* readSecret("botToken");
      const signingSecret = yield* readSecret("signingSecret");
      const appToken = yield* readSecret("appToken");
      const transportSecret = config.transport === "socket" ? appToken : signingSecret;
      if (Option.isNone(botToken) || Option.isNone(transportSecret)) {
        yield* Ref.set(connection, { state: "missing_secrets", error: null });
        return;
      }
      yield* Ref.set(connection, { state: "starting", error: null });
      const started = yield* Effect.tryPromise(() =>
        SlackChatHost.startSlackChatHost({
          transport: config.transport,
          botToken: botToken.value,
          signingSecret: Option.getOrUndefined(signingSecret),
          appToken: Option.getOrUndefined(appToken),
          state,
          onEvent: (event) =>
            runPromise(
              core
                .receive(event)
                .pipe(
                  Effect.tap((outcome) =>
                    outcome.type === "ignored"
                      ? Effect.logDebug("Chat message ignored", { reason: outcome.reason })
                      : Effect.void,
                  ),
                ),
            ),
          onError: logFailure("Chat message handling failed"),
          log: (level, line) =>
            void runPromise(
              level === "info"
                ? Effect.logInfo(`Slack: ${line}`)
                : level === "warn"
                  ? Effect.logWarning(`Slack: ${line}`)
                  : Effect.logError(`Slack: ${line}`),
            ),
        }),
      ).pipe(Effect.result);
      if (started._tag === "Failure") {
        // Slack errors name the failing call, not the credential, so the message is safe to show.
        const message =
          started.failure.cause instanceof Error
            ? started.failure.cause.message
            : "Slack did not connect.";
        yield* Ref.set(connection, { state: "failed", error: message });
        return;
      }
      yield* Ref.set(host, started.success);
      yield* Ref.set(connection, { state: "running", error: null });
    }),
  );

  const getStatus = Effect.fn("ChatBridgeService.getStatus")(function* () {
    const config = yield* configStore.slack.pipe(
      Effect.mapError(bridgeError("Could not read settings.")),
    );
    const present = (name: ChatBridgeSlackSecretName) =>
      readSecret(name).pipe(Effect.map(Option.isSome));
    const url = yield* webhookUrl;
    const current = yield* Ref.get(connection);
    return {
      slack: {
        config,
        secrets: {
          botToken: yield* present("botToken"),
          signingSecret: yield* present("signingSecret"),
          appToken: yield* present("appToken"),
        },
        connection: current.state,
        error: current.error,
        webhookUrl: url,
        manifest: slackAppManifest({
          appName: "T3 Code",
          transport: config.transport,
          webhookUrl: url,
        }),
      },
    } satisfies ChatBridgeStatus;
  });

  /** Posts each finished chat run's answer to its chat thread. */
  const deliverReplies = threads.streamDomainEvents.pipe(
    Stream.filter((event) => event.type === "run.updated"),
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const reply = yield* core.claimReply(event.payload);
        if (Option.isNone(reply)) return;
        const current = yield* Ref.get(host);
        const posted =
          current === null
            ? false
            : yield* Effect.tryPromise(() => current.post(reply.value)).pipe(
                Effect.as(true),
                Effect.catch((error) =>
                  Effect.logWarning("Could not post a chat reply", {
                    error: String(error.cause),
                  }).pipe(Effect.as(false)),
                ),
              );
        // An unposted reply is released so a later replay of the run can try again.
        if (!posted) yield* core.releaseReply(reply.value.runId);
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Chat reply failed", { cause }))),
    ),
  );

  return ChatBridgeService.of({
    start: Effect.fn("ChatBridgeService.start")(function* () {
      yield* reload.pipe(
        Effect.catchCause((cause) => Effect.logWarning("Chat bridge did not start", { cause })),
      );
      yield* Effect.addFinalizer(() => lifecycle.withPermits(1)(stopHost));
      yield* Effect.forkScoped(
        deliverReplies.pipe(
          Effect.catchCause((cause) => Effect.logWarning("Chat reply stream stopped", { cause })),
        ),
      );
    }),
    getStatus,
    updateSlackConfig: Effect.fn("ChatBridgeService.updateSlackConfig")(function* (config) {
      yield* configStore
        .setSlack(config)
        .pipe(Effect.mapError(bridgeError("Could not save settings.")));
      yield* reload;
      return yield* getStatus();
    }),
    setSlackSecret: Effect.fn("ChatBridgeService.setSlackSecret")(function* (input) {
      const name = SECRET_NAMES[input.name];
      yield* (
        input.value === null
          ? secrets.remove(name)
          : secrets.set(name, new TextEncoder().encode(input.value.trim()))
      ).pipe(Effect.mapError(bridgeError("Could not save the Slack secret.")));
      yield* reload;
      return yield* getStatus();
    }),
    postFromThread: Effect.fn("ChatBridgeService.postFromThread")(function* (input) {
      const binding = yield* bindings
        .getByThread(input.threadId)
        .pipe(Effect.mapError(bridgeError("Could not read the chat binding.")));
      if (Option.isNone(binding)) return Option.none();
      const current = yield* Ref.get(host);
      if (current === null) {
        return yield* new ChatBridgeError({ message: "The Slack bridge is not running." });
      }
      const chatThreadKey = binding.value.chatThreadKey;
      yield* Effect.tryPromise(() =>
        current.post({ chatThreadKey, text: input.text, files: input.files }),
      ).pipe(
        Effect.mapError(
          (error) =>
            new ChatBridgeError({
              message: SlackChatHost.redactSlackSecrets(
                `Slack rejected the post: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
              ),
            }),
        ),
      );
      return Option.some({ chatThreadKey });
    }),
    handleSlackHook: Effect.fn("ChatBridgeService.handleSlackHook")(function* (token, request) {
      const expected = yield* hookToken.pipe(Effect.option);
      if (Option.isNone(expected) || !timingSafeEqualBase64Url(token, expected.value))
        return Option.none();
      const current = yield* Ref.get(host);
      if (current === null) {
        return Option.some(Response.json({ error: "chat_bridge_off" }, { status: 409 }));
      }
      return yield* Effect.tryPromise(() => current.handleWebhook(request)).pipe(
        Effect.asSome,
        Effect.orElseSucceed(() =>
          Option.some(Response.json({ error: "internal_error" }, { status: 500 })),
        ),
      );
    }),
  });
});

export const layer = Layer.effect(ChatBridgeService, make);
