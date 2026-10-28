/**
 * Settings and RPCs for the chat bridge, which lets chat platforms (Slack
 * first) start and continue T3 threads. Only what the client and server share
 * lives here; inbound events, bindings and replies are server-internal.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthSettingsWriteScope, EnvironmentAuthorizationError } from "./auth.ts";
import { ProjectId } from "./baseSchemas.ts";

/** Slack channel, user and team IDs: upper-case letters and digits, such as `C0123ABCD`. */
export const SlackId = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{2,32}$/));
export type SlackId = typeof SlackId.Type;

/**
 * `socket` holds an outbound WebSocket to Slack, so it needs no public URL.
 * `webhook` receives Slack's HTTP events through this environment's hook URL,
 * which T3 Connect's relay can forward.
 */
export const ChatBridgeSlackTransport = Schema.Literals(["socket", "webhook"]);
export type ChatBridgeSlackTransport = typeof ChatBridgeSlackTransport.Type;

export const ChatBridgeChannelProject = Schema.Struct({
  channelId: SlackId,
  projectId: ProjectId,
});
export type ChatBridgeChannelProject = typeof ChatBridgeChannelProject.Type;

export const ChatBridgeSlackConfig = Schema.Struct({
  enabled: Schema.Boolean,
  transport: ChatBridgeSlackTransport,
  /** A mention in a channel not listed here is ignored. */
  channelProjects: Schema.Array(ChatBridgeChannelProject),
  /** Slack user IDs that may start or continue a thread. Everyone else is ignored. */
  allowedUserIds: Schema.Array(SlackId),
});
export type ChatBridgeSlackConfig = typeof ChatBridgeSlackConfig.Type;

export const DEFAULT_CHAT_BRIDGE_SLACK_CONFIG: ChatBridgeSlackConfig = {
  enabled: false,
  transport: "socket",
  channelProjects: [],
  allowedUserIds: [],
};

export const ChatBridgeSlackSecretName = Schema.Literals(["botToken", "signingSecret", "appToken"]);
export type ChatBridgeSlackSecretName = typeof ChatBridgeSlackSecretName.Type;

export const ChatBridgeConnectionState = Schema.Literals([
  "off",
  "missing_secrets",
  "starting",
  "running",
  "failed",
]);
export type ChatBridgeConnectionState = typeof ChatBridgeConnectionState.Type;

export const ChatBridgeStatus = Schema.Struct({
  slack: Schema.Struct({
    config: ChatBridgeSlackConfig,
    /** Which secrets are stored. Values never leave the server. */
    secrets: Schema.Struct({
      botToken: Schema.Boolean,
      signingSecret: Schema.Boolean,
      appToken: Schema.Boolean,
    }),
    connection: ChatBridgeConnectionState,
    error: Schema.NullOr(Schema.String),
    /** The public Events URL through T3 Connect, when this environment has one. */
    webhookUrl: Schema.NullOr(Schema.String),
    /** A Slack app manifest (JSON) for the current transport, to paste into api.slack.com. */
    manifest: Schema.String,
  }),
});
export type ChatBridgeStatus = typeof ChatBridgeStatus.Type;

export const ChatBridgeSetSlackSecretInput = Schema.Struct({
  name: ChatBridgeSlackSecretName,
  /** Null removes the secret. */
  value: Schema.NullOr(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
});
export type ChatBridgeSetSlackSecretInput = typeof ChatBridgeSetSlackSecretInput.Type;

export class ChatBridgeError extends Schema.TaggedError<ChatBridgeError>()("ChatBridgeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const CHAT_BRIDGE_WS_METHODS = {
  getStatus: "chatBridge.getStatus",
  updateSlackConfig: "chatBridge.updateSlackConfig",
  setSlackSecret: "chatBridge.setSlackSecret",
} as const;

/** The status carries the hook URL, which embeds a bearer token, so reading it needs write scope too. */
export const CHAT_BRIDGE_CLIENT_GUARDED_RPC_SCOPES = {
  [CHAT_BRIDGE_WS_METHODS.getStatus]: AuthSettingsWriteScope,
  [CHAT_BRIDGE_WS_METHODS.updateSlackConfig]: AuthSettingsWriteScope,
  [CHAT_BRIDGE_WS_METHODS.setSlackSecret]: AuthSettingsWriteScope,
} as const;

const ChatBridgeRpcError = Schema.Union([ChatBridgeError, EnvironmentAuthorizationError]);

export const ChatBridgeRpcs = [
  Rpc.make(CHAT_BRIDGE_WS_METHODS.getStatus, {
    payload: Schema.Struct({}),
    success: ChatBridgeStatus,
    error: ChatBridgeRpcError,
  }),
  Rpc.make(CHAT_BRIDGE_WS_METHODS.updateSlackConfig, {
    payload: ChatBridgeSlackConfig,
    success: ChatBridgeStatus,
    error: ChatBridgeRpcError,
  }),
  Rpc.make(CHAT_BRIDGE_WS_METHODS.setSlackSecret, {
    payload: ChatBridgeSetSlackSecretInput,
    success: ChatBridgeStatus,
    error: ChatBridgeRpcError,
  }),
] as const;
