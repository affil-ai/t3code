import {
  OfficeThread,
  OfficeRequester,
  OfficeUpsertThreadInput,
  OfficeError,
  isOfficeError,
  type OfficeSnapshot,
  type ThreadId,
  type MessageId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class OfficeService extends Context.Service<
  OfficeService,
  {
    readonly subscribe: () => Stream.Stream<OfficeSnapshot, OfficeError>;
    readonly upsertThread: (input: OfficeUpsertThreadInput) => Effect.Effect<void, OfficeError>;
    readonly requesterForMessage: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    }) => Effect.Effect<OfficeRequester | null, OfficeError>;
    /** Resolve an unregistered message using the Office thread's latest requester identity. */
    readonly requesterForMessageWithFallback: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    }) => Effect.Effect<OfficeRequester | null, OfficeError>;
    readonly inheritRequester: (input: {
      readonly threadId: ThreadId;
      readonly sourceMessageId: MessageId;
      readonly messageId: MessageId;
    }) => Effect.Effect<void, OfficeError>;
    readonly removeThread: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, OfficeError>;
  }
>()("t3/office/OfficeService") {}

const json = Schema.fromJsonString(OfficeThread);
const decodeThread = Schema.decodeEffect(OfficeThread);
const decodeJson = Schema.decodeUnknownEffect(json);
const encodeJson = Schema.encodeEffect(json);
const requesterJson = Schema.fromJsonString(OfficeRequester);
const decodeRequester = Schema.decodeEffect(requesterJson);
const encodeRequester = Schema.encodeEffect(requesterJson);
const decodeRegistration = Schema.decodeEffect(OfficeUpsertThreadInput);
export const layer = Layer.effect(
  OfficeService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* PubSub.sliding<void>(1);
    // Fork tables must not change upstream's numbered migrations.
    yield* sql`CREATE TABLE IF NOT EXISTS office_thread (thread_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS office_git_request (
      thread_id TEXT NOT NULL, message_id TEXT NOT NULL, requester_json TEXT NOT NULL,
      PRIMARY KEY(thread_id, message_id)
    )`;
    const snapshot = () =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          metadata_json: string;
        }>`SELECT metadata_json FROM office_thread ORDER BY thread_id`;
        return {
          threads: yield* Effect.forEach(rows, (row) => decodeJson(row.metadata_json)),
        };
      }).pipe(
        Effect.mapError(
          (cause) => new OfficeError({ message: "Could not read Office groups.", cause }),
        ),
      );
    const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    const service: OfficeService["Service"] = {
      subscribe: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            return Stream.concat(
              Stream.fromEffect(snapshot()),
              Stream.fromSubscription(subscription).pipe(Stream.mapEffect(snapshot)),
            );
          }),
        ),
      // Register before dispatch, including bootstrap. Retrying replaces the same row.
      upsertThread: (input) =>
        Effect.gen(function* () {
          const registration = yield* decodeRegistration(input);
          const value = yield* decodeThread(registration);
          const encoded = yield* encodeJson(value);
          const requester = yield* encodeRequester(registration.request.requester);
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO office_git_request (thread_id, message_id, requester_json)
              VALUES (${value.threadId}, ${registration.request.messageId}, ${requester})
              ON CONFLICT(thread_id, message_id) DO NOTHING`;
              const rows = yield* sql<{
                requester_json: string;
              }>`SELECT requester_json FROM office_git_request
              WHERE thread_id = ${value.threadId} AND message_id = ${registration.request.messageId}`;
              // Retries can rename a channel, but cannot change the author of an
              // already registered request while its agent or subagent runs.
              if (rows[0]?.requester_json !== requester)
                return yield* new OfficeError({ message: "Office request identity changed." });
              yield* sql`INSERT INTO office_thread (thread_id, metadata_json) VALUES (${value.threadId}, ${encoded}) ON CONFLICT(thread_id) DO UPDATE SET metadata_json = excluded.metadata_json`;
            }),
          );
          yield* notify;
        }).pipe(
          Effect.mapError((cause) =>
            isOfficeError(cause)
              ? cause
              : new OfficeError({ message: "Could not register Office chat.", cause }),
          ),
        ),
      requesterForMessage: ({ threadId, messageId }) =>
        Effect.gen(function* () {
          const bound =
            yield* sql`SELECT thread_id FROM office_thread WHERE thread_id = ${threadId}`;
          if (!bound.length) {
            if (threadId.startsWith("office:"))
              return yield* new OfficeError({ message: "Office request identity is unavailable." });
            return null;
          }
          const rows = yield* sql<{
            requester_json: string;
          }>`SELECT requester_json FROM office_git_request
            WHERE thread_id = ${threadId} AND message_id = ${messageId}`;
          if (!rows[0])
            return yield* new OfficeError({ message: "Office request identity is unavailable." });
          return yield* decodeRequester(rows[0].requester_json);
        }).pipe(
          Effect.mapError((cause) =>
            isOfficeError(cause)
              ? cause
              : new OfficeError({ message: "Could not resolve Office request identity.", cause }),
          ),
        ),
      requesterForMessageWithFallback: ({ threadId, messageId }) =>
        Effect.gen(function* () {
          const bound =
            yield* sql`SELECT thread_id FROM office_thread WHERE thread_id = ${threadId}`;
          if (!bound.length) {
            if (threadId.startsWith("office:"))
              return yield* new OfficeError({ message: "Office request identity is unavailable." });
            return null;
          }
          const exact = yield* sql<{
            requester_json: string;
          }>`SELECT requester_json FROM office_git_request
            WHERE thread_id = ${threadId} AND message_id = ${messageId}`;
          if (exact[0]) return yield* decodeRequester(exact[0].requester_json);
          const requesters = yield* sql<{
            requester_json: string;
          }>`SELECT requester_json FROM office_git_request
            WHERE thread_id = ${threadId}
            ORDER BY rowid DESC LIMIT 1`;
          if (requesters.length === 0)
            return yield* new OfficeError({ message: "Office request identity is unavailable." });
          return yield* decodeRequester(requesters[0]!.requester_json);
        }).pipe(
          Effect.mapError((cause) =>
            isOfficeError(cause)
              ? cause
              : new OfficeError({ message: "Could not resolve Office request identity.", cause }),
          ),
        ),
      inheritRequester: (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const requester = yield* service.requesterForMessage({
                threadId: input.threadId,
                messageId: input.sourceMessageId,
              });
              if (requester === null) return;
              const encoded = yield* encodeRequester(requester);
              yield* sql`INSERT INTO office_git_request (thread_id, message_id, requester_json)
          VALUES (${input.threadId}, ${input.messageId}, ${encoded}) ON CONFLICT(thread_id, message_id) DO NOTHING`;
              const rows = yield* sql<{
                requester_json: string;
              }>`SELECT requester_json FROM office_git_request
          WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId}`;
              if (rows[0]?.requester_json !== encoded)
                return yield* new OfficeError({ message: "Office request identity changed." });
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              isOfficeError(cause)
                ? cause
                : new OfficeError({ message: "Could not inherit Office request identity.", cause }),
            ),
          ),
      removeThread: ({ threadId }) =>
        Effect.gen(function* () {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM office_git_request WHERE thread_id = ${threadId}`;
              yield* sql`DELETE FROM office_thread WHERE thread_id = ${threadId}`;
            }),
          );
          yield* notify;
        }).pipe(
          Effect.mapError(
            (cause) => new OfficeError({ message: "Could not remove Office grouping.", cause }),
          ),
        ),
    };
    return service;
  }),
);
