/**
 * Which T3 thread answers which chat thread, and which runs already replied.
 */
import { ProjectId, type RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { ensureSchema } from "./schema.ts";

export interface ChatThreadBinding {
  readonly chatThreadKey: string;
  readonly platform: "slack";
  readonly channelId: string;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly createdByUserId: string;
}

export class ChatBindingStoreError extends Data.TaggedError("ChatBindingStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ChatBindingStore extends Context.Service<
  ChatBindingStore,
  {
    readonly get: (
      chatThreadKey: string,
    ) => Effect.Effect<Option.Option<ChatThreadBinding>, ChatBindingStoreError>;
    readonly getByThread: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ChatThreadBinding>, ChatBindingStoreError>;
    readonly insert: (binding: ChatThreadBinding) => Effect.Effect<void, ChatBindingStoreError>;
    /** True the first time a run is claimed. */
    readonly claimReply: (
      runId: RunId,
      chatThreadKey: string,
    ) => Effect.Effect<boolean, ChatBindingStoreError>;
    readonly releaseReply: (runId: RunId) => Effect.Effect<void, ChatBindingStoreError>;
    /** Marks a run whose message did not start it as answering a chat thread. */
    readonly oweReply: (
      runId: RunId,
      chatThreadKey: string,
    ) => Effect.Effect<void, ChatBindingStoreError>;
    readonly isReplyOwed: (runId: RunId) => Effect.Effect<boolean, ChatBindingStoreError>;
  }
>()("t3/chatBridge/ChatBindingStore") {}

interface BindingRow {
  readonly chat_thread_key: string;
  readonly platform: string;
  readonly channel_id: string;
  readonly project_id: string;
  readonly thread_id: string;
  readonly created_by_user_id: string;
}

const fromRow = (row: BindingRow): ChatThreadBinding => ({
  chatThreadKey: row.chat_thread_key,
  platform: "slack",
  channelId: row.channel_id,
  projectId: ProjectId.make(row.project_id),
  threadId: ThreadId.make(row.thread_id),
  createdByUserId: row.created_by_user_id,
});

const storeError = (message: string) => (cause: unknown) =>
  new ChatBindingStoreError({ message, cause });

export const makeSqlite = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureSchema;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  return ChatBindingStore.of({
    get: (chatThreadKey) =>
      sql<BindingRow>`SELECT * FROM chat_bridge_binding WHERE chat_thread_key = ${chatThreadKey}`.pipe(
        Effect.map(([row]) => Option.map(Option.fromUndefinedOr(row), fromRow)),
        Effect.mapError(storeError("Could not read the chat binding.")),
      ),
    getByThread: (threadId) =>
      sql<BindingRow>`SELECT * FROM chat_bridge_binding WHERE thread_id = ${threadId}`.pipe(
        Effect.map(([row]) => Option.map(Option.fromUndefinedOr(row), fromRow)),
        Effect.mapError(storeError("Could not read the chat binding.")),
      ),
    insert: Effect.fn("ChatBindingStore.insert")(
      function* (binding: ChatThreadBinding) {
        const createdAt = yield* nowIso;
        // A replayed launch returns the same thread, so the second insert is a no-op.
        yield* sql`INSERT INTO chat_bridge_binding
          (chat_thread_key, platform, channel_id, project_id, thread_id, created_by_user_id, created_at)
          VALUES (${binding.chatThreadKey}, ${binding.platform}, ${binding.channelId},
            ${binding.projectId}, ${binding.threadId}, ${binding.createdByUserId}, ${createdAt})
          ON CONFLICT (chat_thread_key) DO NOTHING`;
      },
      Effect.mapError(storeError("Could not save the chat binding.")),
    ),
    claimReply: Effect.fn("ChatBindingStore.claimReply")(
      function* (runId: RunId, chatThreadKey: string) {
        const claimedAt = yield* nowIso;
        const rows = yield* sql`INSERT INTO chat_bridge_reply (run_id, chat_thread_key, claimed_at)
          VALUES (${runId}, ${chatThreadKey}, ${claimedAt})
          ON CONFLICT (run_id) DO NOTHING RETURNING run_id`;
        return rows.length > 0;
      },
      Effect.mapError(storeError("Could not claim the chat reply.")),
    ),
    releaseReply: (runId) =>
      sql`DELETE FROM chat_bridge_reply WHERE run_id = ${runId}`.pipe(
        Effect.asVoid,
        Effect.mapError(storeError("Could not release the chat reply.")),
      ),
    oweReply: (runId, chatThreadKey) =>
      sql`INSERT INTO chat_bridge_owed_reply (run_id, chat_thread_key)
        VALUES (${runId}, ${chatThreadKey}) ON CONFLICT (run_id) DO NOTHING`.pipe(
        Effect.asVoid,
        Effect.mapError(storeError("Could not record the owed chat reply.")),
      ),
    isReplyOwed: (runId) =>
      sql`SELECT 1 FROM chat_bridge_owed_reply WHERE run_id = ${runId}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(storeError("Could not read the owed chat reply.")),
      ),
  });
});

export const layerSqlite = Layer.effect(ChatBindingStore, makeSqlite);
