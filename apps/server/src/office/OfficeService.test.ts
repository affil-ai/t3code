import { describe, expect, it } from "@effect/vitest";
import { MessageId, OfficeThread, ThreadId } from "@t3tools/contracts";
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
const request = {
  messageId: MessageId.make("receipt-1"),
  requester: { name: "Vivek", email: "vivek@example.test" },
};
const registration = { ...entry, request };
const read = (service: OfficeService["Service"]) =>
  service.subscribe().pipe(Stream.runHead, Effect.map(Option.getOrThrow));

describe("OfficeService", () => {
  it.effect("keeps each message's requester when another person posts in the same chat", () =>
    Effect.gen(function* () {
      const service = yield* OfficeService;
      yield* service.upsertThread(registration);
      const second = {
        messageId: MessageId.make("receipt-2"),
        requester: { name: "Lilly", email: "lilly@example.test" },
      };
      yield* service.upsertThread({ ...registration, request: second });
      expect(
        yield* service.requesterForMessage({
          threadId: entry.threadId,
          messageId: request.messageId,
        }),
      ).toEqual(request.requester);
      expect(
        yield* service.requesterForMessage({
          threadId: entry.threadId,
          messageId: second.messageId,
        }),
      ).toEqual(second.requester);
      expect((yield* read(service)).threads).toEqual([entry]);
      expect(
        yield* service.requesterForMessage({
          threadId: ThreadId.make("personal-thread"),
          messageId: request.messageId,
        }),
      ).toBeNull();
      const missing = yield* service
        .requesterForMessage({
          threadId: entry.threadId,
          messageId: MessageId.make("unknown-message"),
        })
        .pipe(Effect.flip);
      expect(missing.message).toBe("Office request identity is unavailable.");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects a changed requester on retry without changing grouping or the original requester",
    () =>
      Effect.gen(function* () {
        const service = yield* OfficeService;
        yield* service.upsertThread(registration);
        const rejected = yield* service
          .upsertThread({
            ...registration,
            label: "#changed",
            request: {
              ...request,
              requester: { name: "Another person", email: "other@example.test" },
            },
          })
          .pipe(Effect.flip);
        expect(rejected.message).toBe("Office request identity changed.");
        expect((yield* read(service)).threads).toEqual([entry]);
        expect(
          yield* service.requesterForMessage({
            threadId: entry.threadId,
            messageId: request.messageId,
          }),
        ).toEqual(request.requester);
        yield* service.removeThread({ threadId: entry.threadId });
        const missingIdentity = yield* service
          .requesterForMessage({ threadId: entry.threadId, messageId: request.messageId })
          .pipe(Effect.flip);
        expect(missingIdentity.message).toBe("Office request identity is unavailable.");
        const sql = yield* SqlClient.SqlClient;
        expect((yield* sql`SELECT * FROM office_git_request`).length).toBe(0);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects commit-trailer injection before registering a chat or requester", () =>
    Effect.gen(function* () {
      const service = yield* OfficeService;
      yield* service
        .upsertThread({
          ...registration,
          request: {
            ...request,
            requester: { ...request.requester, name: "Vivek\nCo-authored-by: Other" },
          },
        })
        .pipe(Effect.flip);
      expect((yield* read(service)).threads).toEqual([]);
      const sql = yield* SqlClient.SqlClient;
      expect((yield* sql`SELECT * FROM office_git_request`).length).toBe(0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "retries registration without duplicating chats, updates labels, and removes Office metadata",
    () =>
      Effect.gen(function* () {
        const service = yield* OfficeService;
        expect((yield* read(service)).threads).toEqual([]);
        yield* service.upsertThread(registration);
        yield* service.upsertThread(registration);
        yield* service.upsertThread({ ...registration, label: "#renamed" });
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
      yield* service.upsertThread(registration);
      yield* Deferred.await(received);
      yield* Fiber.interrupt(reader);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects blank metadata before writing a row", () =>
    Effect.gen(function* () {
      const service = yield* OfficeService;
      const result = yield* service.upsertThread({ ...registration, label: " " }).pipe(Effect.flip);
      expect(result._tag).toBe("OfficeError");
      expect((yield* read(service)).threads).toEqual([]);
      yield* service.removeThread({ threadId: ThreadId.make("missing") });
    }).pipe(Effect.provide(testLayer)),
  );
});
