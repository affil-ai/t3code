import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  type OrchestrationV2ServerCommand,
  type SecretRequestField,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-orchestrator");
const turnItemId = TurnItemId.make("turn-item:secret-request:1");
const projectId = ProjectId.make("project-1");

/** Runs `body` against the service with an in-memory store and a thread holding one request. */
const withService = <A, E>(
  body: (input: {
    readonly service: SecretRequests.SecretRequests["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Effect.Effect<A, E>,
  options: {
    readonly threadId?: ThreadId;
    readonly runStatus?: string;
    readonly removeFails?: boolean;
    /** The agent's wait closes the card just before the answer's record lands. */
    readonly closedFirst?: boolean;
    /** How many record dispatches fail before one succeeds. */
    readonly failedRecords?: number;
    /** The card asks for several named values. */
    readonly fields?: ReadonlyArray<SecretRequestField>;
  } = {},
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    let secretStatus = "pending";
    let failedRecords = options.failedRecords ?? 0;
    const requestThreadId = options.threadId ?? threadId;
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.succeed(
        ServerSecretStore.ServerSecretStore,
        ServerSecretStore.ServerSecretStore.of({
          // Yields like a real file read, so concurrent callers can interleave.
          get: (name) => Effect.yieldNow.pipe(Effect.as(Option.fromNullishOr(stored.get(name)))),
          set: (name, value) => Effect.sync(() => void stored.set(name, value)),
          create: (name, value) =>
            stored.has(name)
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new PlatformError.PlatformError(
                      new PlatformError.SystemError({
                        _tag: "AlreadyExists",
                        module: "FileSystem",
                        method: "open",
                      }),
                    ),
                  } as never),
                )
              : Effect.sync(() => void stored.set(name, value)),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const existing = stored.get(name);
              if (existing) return existing;
              const value = new Uint8Array(bytes).fill(7);
              stored.set(name, value);
              return value;
            }),
          remove: (name) =>
            options.removeFails
              ? Effect.fail(
                  new ServerSecretStore.SecretStorePersistError({
                    resource: name,
                    cause: new Error("read-only"),
                  }),
                )
              : Effect.sync(() => void stored.delete(name)),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { projectId },
            runs: [{ id: "run-1", status: options.runStatus ?? "running" }],
            turnItems: [
              {
                id: turnItemId,
                threadId: requestThreadId,
                runId: "run-1",
                nodeId: "node-root",
                type: "secret_request",
                label: "GitHub token",
                reason: "Used as GH_TOKEN.",
                ...(options.fields === undefined ? {} : { fields: options.fields }),
                secretStatus,
              },
            ],
          } as never),
        dispatch: (command) => {
          if (command.type === "secret_request.record" && failedRecords > 0) {
            failedRecords -= 1;
            return Effect.fail(new Error("orchestrator unavailable") as never);
          }
          return Effect.sync(() => {
            dispatched.push(command);
            // Like the orchestrator, a card that is no longer pending keeps its answer.
            if (options.closedFirst && command.type === "secret_request.record") {
              secretStatus = "cancelled";
            } else if (command.type === "secret_request.record" && secretStatus === "pending") {
              secretStatus = command.secretStatus;
            }
            return {} as never;
          });
        },
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* SecretRequests.SecretRequests;
      return yield* body({ service, stored, dispatched });
    }).pipe(Effect.provide(SecretRequests.layer.pipe(Layer.provide(layerDependencies))));
  });

/** The secret values in the store, leaving out the server's own salt. */
const valuesOf = (stored: Map<string, Uint8Array>) =>
  Array.from(stored.entries())
    .filter(([name]) => name !== "secret-request-salt")
    .map(([, bytes]) => new TextDecoder().decode(bytes));

it.effect(
  "a saved answer becomes a ref its thread can reuse, and the thread only learns it was saved",
  () =>
    withService(({ service, dispatched }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        assert.equal(dispatched.length, 1);
        assert.include(dispatched[0] as object, {
          type: "secret_request.record",
          secretStatus: "saved",
        });
        assert.notInclude(Object.values(dispatched[0] as object).map(String), "ghp_secret");

        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        assert.equal(yield* service.use({ ref, threadId }), "ghp_secret");
        assert.equal(yield* service.use({ ref, threadId }), "ghp_secret");
      }),
    ),
);

it.effect("a ref expires 15 minutes after it was saved, and its value is deleted", () =>
  withService(({ service, stored }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      yield* TestClock.adjust("15 minutes");
      assert.equal(yield* service.use({ ref, threadId }), "ghp_secret");
      yield* TestClock.adjust("1 millis");
      const expired = yield* service.use({ ref, threadId }).pipe(Effect.flip);
      assert.equal(expired.reason, "ref_expired");
      assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
    }),
  ),
);

it.effect("a ref only works in the thread that asked for it", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "ghp_secret" },
      });
      const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
      // A subagent or any other thread, even in the same project.
      const elsewhere = yield* service
        .use({ ref, threadId: ThreadId.make("thread:delegated-task:child") })
        .pipe(Effect.flip);
      assert.equal(elsewhere.reason, "ref_unavailable");
      assert.include(elsewhere.message, "another thread");
      // A refused attempt does not burn the ref.
      assert.equal(yield* service.use({ ref, threadId }), "ghp_secret");
    }),
  ),
);

it.effect("a card with fields saves one ref per field", () =>
  withService(
    ({ service, dispatched }) =>
      Effect.gen(function* () {
        // The answer must fill exactly the card's fields.
        for (const answer of [
          { type: "save", secret: "alice" },
          { type: "save", fields: { username: "alice" } },
          { type: "save", fields: { username: "alice", password: "hunter2", otp: "1" } },
          { type: "save", fields: { username: "alice", pin: "hunter2" } },
        ] as const) {
          const mismatch = yield* service
            .answer({ threadId, turnItemId, answer })
            .pipe(Effect.flip);
          assert.equal(mismatch.reason, "fields_mismatch");
        }
        assert.equal(dispatched.length, 0);
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", fields: { username: "alice", password: "hunter2" } },
        });
        assert.deepEqual((dispatched[0] as { fields?: unknown }).fields, [
          { name: "username", label: "Username" },
          { name: "password", label: "Password" },
        ]);
        const username = Option.getOrThrow(
          yield* service.savedRef({ threadId, turnItemId, field: "username" }),
        );
        const password = Option.getOrThrow(
          yield* service.savedRef({ threadId, turnItemId, field: "password" }),
        );
        assert.notEqual(username, password);
        assert.equal(yield* service.use({ ref: username, threadId }), "alice");
        assert.equal(yield* service.use({ ref: password, threadId }), "hunter2");
        // A card with fields has no ref of its own.
        assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
      }),
    {
      fields: [
        { name: "username", label: "Username" },
        { name: "password", label: "Password" },
      ],
    },
  ),
);

it.effect("a save that loses to the card closing deletes the value and says so", () =>
  withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        const error = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(error.reason, "agent_stopped");
        assert.isFalse(valuesOf(stored).some((value) => value.includes("ghp_secret")));
      }),
    { closedFirst: true },
  ),
);

it.effect("a save whose record failed can be saved again", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        const failed = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.equal(failed.reason, "record_failed");
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        assert.equal(yield* service.use({ ref, threadId }), "ghp_secret");
      }),
    { failedRecords: 1 },
  ),
);

it.effect("a save whose record and cleanup both failed is finished by saving again", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        assert.isTrue(Option.isSome(yield* service.savedRef({ threadId, turnItemId })));
      }),
    { failedRecords: 1, removeFails: true },
  ),
);

it.effect("a failed save never deletes a value an earlier answer stored", () => {
  const options = { failedRecords: 2, removeFails: true };
  return withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        // The first answer's value stays: its record and its cleanup both failed.
        yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "first" } })
          .pipe(Effect.flip);
        options.removeFails = false;
        // A second answer finds that value, and its own record fails too.
        yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "second" } })
          .pipe(Effect.flip);
        assert.deepInclude(valuesOf(stored).join(), "first");
      }),
    options,
  );
});

it.effect("declining stores nothing, and a request is answered once", () =>
  withService(({ service, stored, dispatched }) =>
    Effect.gen(function* () {
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      assert.deepEqual(valuesOf(stored), []);
      assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
      const late = yield* service
        .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
        .pipe(Effect.flip);
      assert.include(late.message, "already answered");
      assert.equal(dispatched.length, 1);
      assert.deepEqual(valuesOf(stored), []);
    }),
  ),
);

it.effect("traces and counts a saved answer without ever recording the value", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const counted = Metric.snapshot.pipe(
      Effect.map((snapshots) => {
        const found = snapshots.find(
          (snapshot) =>
            snapshot.id === "t3_secret_refs_used_total" && snapshot.attributes?.result === "used",
        );
        return found?.type === "Counter" ? Number(found.state.count) : 0;
      }),
    );
    const before = yield* counted;
    yield* withService(({ service }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        const ref = Option.getOrThrow(yield* service.savedRef({ threadId, turnItemId }));
        yield* service.use({ ref, threadId });
      }),
    ).pipe(Effect.withTracer(tracer));
    assert.equal((yield* counted) - before, 1);
    const recorded = spans.flatMap((span) => [
      span.name,
      ...Array.from(span.attributes.values(), String),
    ]);
    assert.include(recorded, "SecretRequests.answer");
    assert.include(recorded, "SecretRequests.use");
    assert.isFalse(recorded.some((value) => value.includes("ghp_secret")));
  }),
);

it.effect("works in threads with long ids, such as a delegated subagent's", () => {
  const delegatedThreadId = ThreadId.make(
    `thread:delegated-task:command%3Amcp%3A${"a".repeat(36)}%3Adelegate-task%3Arelease-notes-v0.2.0-${"b".repeat(40)}`,
  );
  return withService(
    ({ service, stored }) =>
      Effect.gen(function* () {
        yield* service.answer({
          threadId: delegatedThreadId,
          turnItemId,
          answer: { type: "save", secret: "ghp_secret" },
        });
        // Store names never grow with the thread id, so they fit any filesystem.
        assert.isTrue(Array.from(stored.keys()).every((name) => name.length < 100));
        const ref = Option.getOrThrow(
          yield* service.savedRef({ threadId: delegatedThreadId, turnItemId }),
        );
        assert.equal(yield* service.use({ ref, threadId: delegatedThreadId }), "ghp_secret");
      }),
    { threadId: delegatedThreadId },
  );
});

it.effect("refuses an answer once the agent that asked has stopped", () =>
  withService(
    ({ service, stored, dispatched }) =>
      Effect.gen(function* () {
        const late = yield* service
          .answer({ threadId, turnItemId, answer: { type: "save", secret: "ghp_secret" } })
          .pipe(Effect.flip);
        assert.include(late.message, "has stopped");
        assert.deepEqual(valuesOf(stored), []);
        assert.equal(dispatched.length, 0);
      }),
    { runStatus: "completed" },
  ),
);

it.effect("drops values nobody used once they expire, and keeps the rest", () =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const encode = (savedAt: number) =>
      new TextEncoder().encode(
        `{"threadId":"thread-orchestrator","value":"ghp_secret","savedAt":${savedAt}}`,
      );
    yield* TestClock.adjust("2 days");
    const now = yield* Clock.currentTimeMillis;
    const stale = `secret-request-${"a".repeat(32)}`;
    const fresh = `secret-request-${"b".repeat(32)}`;
    yield* store.set(stale, encode(now - SecretRequests.SECRET_REF_TTL_MS - 1));
    yield* store.set(fresh, encode(now));
    yield* store.set("unrelated", new Uint8Array([1]));

    // Building the service runs the first sweep.
    yield* Effect.gen(function* () {
      yield* SecretRequests.SecretRequests;
    }).pipe(
      Effect.provide(
        SecretRequests.layer.pipe(
          Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
        ),
      ),
      Effect.scoped,
    );

    assert.isTrue(Option.isNone(yield* store.get(stale)));
    assert.isTrue(Option.isSome(yield* store.get(fresh)));
    assert.isTrue(Option.isSome(yield* store.get("unrelated")));
    assert.isTrue(Option.isSome(yield* store.get("secret-request-salt")));
  }).pipe(
    Effect.provide(
      ServerSecretStore.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-requests-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
