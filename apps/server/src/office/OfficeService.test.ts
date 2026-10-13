import { describe, expect, it } from "@effect/vitest";
import { OfficeThread, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { OfficeService, layer } from "./OfficeService.ts";

const dependencies = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = layer.pipe(Layer.provideMerge(dependencies));
const entry = Schema.decodeSync(OfficeThread)({
  threadId: "office:thread",
  officeChatId: "chat",
  workspaceId: "team",
  conversationId: "C123",
  conversationType: "channel",
  label: "#engineering",
});
const read = (service: OfficeService["Service"]) =>
  service.subscribe().pipe(Stream.runHead, Effect.map(Option.getOrThrow));

describe("OfficeService", () => {
  it.effect(
    "retries registration without duplicating chats, updates labels, and removes only grouping",
    () =>
      Effect.gen(function* () {
        const service = yield* OfficeService;
        expect((yield* read(service)).threads).toEqual([]);
        yield* service.upsertThread(entry);
        yield* service.upsertThread(entry);
        yield* service.upsertThread({ ...entry, label: "#renamed" });
        expect((yield* read(service)).threads).toEqual([{ ...entry, label: "#renamed" }]);
        const sql = yield* SqlClient.SqlClient;
        expect((yield* sql`SELECT * FROM office_thread`).length).toBe(1);
        yield* service.removeThread({ threadId: entry.threadId });
        yield* service.removeThread({ threadId: entry.threadId });
        expect((yield* read(service)).threads).toEqual([]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("streams committed metadata changes after the initial snapshot", () =>
    Effect.gen(function* () {
      const service = yield* OfficeService;
      const subscribed = yield* Deferred.make<void>();
      const received = yield* Deferred.make<void>();
      const reader = yield* service.subscribe().pipe(
        Stream.runForEach((snapshot) =>
          snapshot.threads.length === 0
            ? Deferred.succeed(subscribed, undefined)
            : Deferred.succeed(received, undefined),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* service.upsertThread(entry);
      yield* Deferred.await(received);
      yield* Fiber.interrupt(reader);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects blank metadata before writing a row", () =>
    Effect.gen(function* () {
      const service = yield* OfficeService;
      const result = yield* service.upsertThread({ ...entry, label: " " }).pipe(Effect.flip);
      expect(result._tag).toBe("OfficeError");
      expect((yield* read(service)).threads).toEqual([]);
      yield* service.removeThread({ threadId: ThreadId.make("missing") });
    }).pipe(Effect.provide(testLayer)),
  );
});
