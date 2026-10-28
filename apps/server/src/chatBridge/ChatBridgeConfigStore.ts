import { ChatBridgeSlackConfig, DEFAULT_CHAT_BRIDGE_SLACK_CONFIG } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureSchema } from "./schema.ts";

export class ChatBridgeConfigError extends Data.TaggedError("ChatBridgeConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ChatBridgeConfigStore extends Context.Service<
  ChatBridgeConfigStore,
  {
    readonly slack: Effect.Effect<ChatBridgeSlackConfig, ChatBridgeConfigError>;
    readonly setSlack: (
      config: ChatBridgeSlackConfig,
    ) => Effect.Effect<void, ChatBridgeConfigError>;
  }
>()("t3/chatBridge/ChatBridgeConfigStore") {}

const configJson = Schema.fromJsonString(ChatBridgeSlackConfig);
// A row a newer build wrote in a shape this one cannot read falls back to off.
const decodeConfig = Schema.decodeUnknownOption(configJson);
const encodeConfig = Schema.encodeSync(configJson);

const configError = (message: string) => (cause: unknown) =>
  new ChatBridgeConfigError({ message, cause });

export const makeSqlite = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureSchema;
  return ChatBridgeConfigStore.of({
    slack: sql<{ config_json: string }>`
      SELECT config_json FROM chat_bridge_config WHERE platform = 'slack'`.pipe(
      Effect.map(([row]) =>
        row === undefined
          ? DEFAULT_CHAT_BRIDGE_SLACK_CONFIG
          : Option.getOrElse(decodeConfig(row.config_json), () => DEFAULT_CHAT_BRIDGE_SLACK_CONFIG),
      ),
      Effect.mapError(configError("Could not read the chat bridge settings.")),
    ),
    setSlack: Effect.fn("ChatBridgeConfigStore.setSlack")(function* (config) {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO chat_bridge_config (platform, config_json, updated_at)
        VALUES ('slack', ${encodeConfig(config)}, ${updatedAt})
        ON CONFLICT (platform) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`.pipe(
        Effect.mapError(configError("Could not save the chat bridge settings.")),
      );
    }),
  });
});

export const layerSqlite = Layer.effect(ChatBridgeConfigStore, makeSqlite);
