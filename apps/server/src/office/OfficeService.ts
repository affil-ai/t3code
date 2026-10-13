import { OfficeThread, OfficeError, type OfficeSnapshot, type ThreadId } from "@t3tools/contracts";
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
    readonly upsertThread: (input: OfficeThread) => Effect.Effect<void, OfficeError>;
    readonly removeThread: (input: {
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, OfficeError>;
  }
>()("t3/office/OfficeService") {}

const json = Schema.fromJsonString(OfficeThread);
const decodeThread = Schema.decodeUnknownEffect(OfficeThread);
const decodeJson = Schema.decodeUnknownEffect(json);
const encodeJson = Schema.encodeEffect(json);
export const layer = Layer.effect(
  OfficeService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* PubSub.sliding<void>(1);
    // Fork tables must not change upstream's numbered migrations.
    yield* sql`CREATE TABLE IF NOT EXISTS office_thread (thread_id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL)`;
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
    return {
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
          const value = yield* decodeThread(input);
          const encoded = yield* encodeJson(value);
          yield* sql`INSERT INTO office_thread (thread_id, metadata_json) VALUES (${value.threadId}, ${encoded}) ON CONFLICT(thread_id) DO UPDATE SET metadata_json = excluded.metadata_json`;
          yield* notify;
        }).pipe(
          Effect.mapError(
            (cause) => new OfficeError({ message: "Could not register Office chat.", cause }),
          ),
        ),
      removeThread: ({ threadId }) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM office_thread WHERE thread_id = ${threadId}`;
          yield* notify;
        }).pipe(
          Effect.mapError(
            (cause) => new OfficeError({ message: "Could not remove Office grouping.", cause }),
          ),
        ),
    };
  }),
);
