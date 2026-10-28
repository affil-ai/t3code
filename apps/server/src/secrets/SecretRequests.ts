/**
 * The user's answer goes straight to the server's secret store under a
 * SecretRef; orchestration only records the request and its status. A tool
 * that needs the value takes the ref and reads it server-side, so the value
 * never reaches the transcript, projections, clients, or model context.
 *
 * A ref works only for the thread that asked, as often as it likes, until
 * SECRET_REF_TTL_MS after the user saved it. A card with several fields
 * saves one ref per field. A `file` request instead moves its value to an
 * owner-only file for the agent's own shell.
 */
import {
  CommandId,
  SecretRef,
  SecretRequestError,
  type SecretRequestAnswerInput,
  type SecretRequestField,
  type ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
/** How long after the user saves it a ref works; the agent can ask again after. */
export const SECRET_REF_TTL_MS = 15 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;
/** How long a `file` request's file is kept; the tool result promises 24 hours. */
const SECRET_FILE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Each field of a request has exactly one ref, derived from where it was
 * asked. Its length never depends on the thread id, so the store's file names
 * stay within filesystem limits, and the requesting tool finds it without a
 * second record. Unguessable without the server's own salt.
 */
const refFor = (salt: string, threadId: ThreadId, turnItemId: string, field?: string) =>
  SecretRef.make(
    `${SECRET_REF_PREFIX}${NodeCrypto.createHmac("sha256", salt)
      .update(
        field === undefined
          ? `${threadId}\u0000${turnItemId}`
          : `${threadId}\u0000${turnItemId}\u0000${field}`,
      )
      .digest("hex")
      .slice(0, 32)}`,
  );

/** A ref's value, the thread that asked for it, and when it was saved. */
const StoredSecret = Schema.fromJsonString(
  Schema.Struct({ threadId: Schema.String, value: Schema.String, savedAt: Schema.Number }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

type SaveAnswer = Extract<SecretRequestAnswerInput["answer"], { readonly type: "save" }>;

/**
 * The values to store for a save, one per field, or null when the answer does
 * not fit the card: a card with fields takes exactly those names, a card
 * without takes one secret.
 */
const answerValues = (
  fields: ReadonlyArray<SecretRequestField> | undefined,
  answer: SaveAnswer,
): ReadonlyArray<{ readonly field?: string; readonly value: string }> | null => {
  if ("secret" in answer) return fields === undefined ? [{ value: answer.secret }] : null;
  if (fields === undefined || Object.keys(answer.fields).length !== fields.length) return null;
  const values: Array<{ readonly field: string; readonly value: string }> = [];
  for (const field of fields) {
    const value = answer.fields[field.name];
    if (value === undefined) return null;
    values.push({ field: field.name, value });
  }
  return values;
};

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    /**
     * The ref minted when this request was saved, for the tool that asked.
     * `field` names one field of a card with several.
     */
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
      readonly field?: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    /**
     * Reads a ref's value for the thread that asked for it. Fails for unknown
     * and expired refs, and for refs another thread asked for.
     */
    readonly use: (input: {
      readonly ref: SecretRef;
      readonly threadId: ThreadId;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Moves a saved `file` request's value to an owner-only file and returns its path. */
    readonly saveToFile: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<string, SecretRequestError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  // Beside the store's own files so the same owner-only directory and cleanup rules apply.
  const filesDir = store.directory === undefined ? undefined : path.join(store.directory, "files");

  const salt = Buffer.from(
    yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie),
  ).toString("hex");

  const answer: SecretRequests["Service"]["answer"] = Effect.fn("SecretRequests.answer")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "secret_request.answer": input.answer.type,
      });
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["runs", "turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
        return yield* new SecretRequestError({ reason: "not_found" });
      }
      if (item.secretStatus !== "pending") {
        return yield* new SecretRequestError({ reason: "already_answered" });
      }
      const run = records.runs.find((candidate) => candidate.id === item.runId);
      if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
      const values = input.answer.type === "save" ? answerValues(item.fields, input.answer) : [];
      if (values === null) return yield* new SecretRequestError({ reason: "fields_mismatch" });
      const names = values.map(({ field }) =>
        storeName(refFor(salt, input.threadId, item.id, field)),
      );
      const removeAll = Effect.forEach(names, removeLogged, { discard: true });
      // A failed save removes only what it stored itself: a value that was
      // already there belongs to an answer that may have recorded the card.
      const created: Array<string> = [];
      const removeCreated = Effect.suspend(() =>
        Effect.forEach(created, removeLogged, { discard: true }),
      );
      // Store first: the card only says saved once the values are kept. Create,
      // not set: a second answer racing this one must not replace a value.
      // A value already there on a card still pending is an earlier save whose
      // record failed and could not be cleaned up; recording it finishes that save.
      const savedAt = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        values,
        ({ value }, index) =>
          encodeStored({ threadId: input.threadId, value, savedAt }).pipe(
            Effect.orDie,
            Effect.flatMap((encoded) =>
              store
                .create(names[index]!, new TextEncoder().encode(encoded))
                .pipe(Effect.tap(() => Effect.sync(() => created.push(names[index]!)))),
            ),
            Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
            Effect.mapError(
              (error) => new SecretRequestError({ reason: "store_failed", cause: error }),
            ),
          ),
        { discard: true },
      ).pipe(Effect.tapError(() => removeCreated));
      const secretStatus = input.answer.type === "save" ? "saved" : "declined";
      yield* threadManagement
        .dispatch({
          type: "secret_request.record",
          commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
          threadId: input.threadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          label: item.label,
          reason: item.reason,
          ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
          ...(item.fields === undefined ? {} : { fields: item.fields }),
          ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
          secretStatus,
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
          // The card still says pending, so the user can save again; the values
          // stored above would make that retry look already answered.
          Effect.tapError(() => removeCreated),
        );
      if (input.answer.type !== "save") return;
      // The wait may have closed the card; delete unrecorded answers because no one receives their refs.
      const recorded = yield* threadManagement
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        );
      const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
      if (card?.type === "secret_request" && card.secretStatus !== "saved") {
        yield* removeAll;
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
    },
  );

  const savedRef: SecretRequests["Service"]["savedRef"] = Effect.fn("SecretRequests.savedRef")(
    function* (input) {
      const ref = refFor(salt, input.threadId, input.turnItemId, input.field);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    },
  );

  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  const use: SecretRequests["Service"]["use"] = (input) =>
    useRef(input).pipe(
      Effect.tap(() => Metrics.increment(Metrics.secretRefsUsedTotal, { result: "used" })),
      Effect.tapError((error) =>
        Metrics.increment(Metrics.secretRefsUsedTotal, { result: error.reason }),
      ),
      Effect.withSpan("SecretRequests.use"),
    );

  /** A live ref's value for the thread that asked, left in the store. */
  const useRef = Effect.fn("SecretRequests.useRef")(function* (input: {
    readonly ref: SecretRef;
    readonly threadId: ThreadId;
  }) {
    if (!REF_PATTERN.test(input.ref))
      return yield* new SecretRequestError({ reason: "invalid_ref" });
    const stored = yield* store
      .get(storeName(input.ref))
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })));
    const decoded = Option.flatMap(stored, (bytes) =>
      decodeStored(new TextDecoder().decode(bytes)),
    );
    // Another thread's ref reads as missing, so a ref leaks nothing about
    // whether it exists elsewhere.
    if (Option.isNone(decoded) || decoded.value.threadId !== input.threadId) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    if ((yield* Clock.currentTimeMillis) - decoded.value.savedAt > SECRET_REF_TTL_MS) {
      yield* removeLogged(storeName(input.ref));
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    return decoded.value.value;
  });

  // Two calls for one request must not both write its file or both remove its stored copy.
  const fileLock = yield* Semaphore.make(1);
  const saveToFile: SecretRequests["Service"]["saveToFile"] = Effect.fn(
    "SecretRequests.saveToFile",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    // Only a card that told the user the agent's commands can read the value may write it out.
    if (
      item?.type !== "secret_request" ||
      item.secretStatus !== "saved" ||
      item.delivery !== "file"
    ) {
      return yield* new SecretRequestError({ reason: "not_a_file_request" });
    }
    if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const ref = refFor(salt, input.threadId, item.id);
    const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
    return yield* Effect.gen(function* () {
      // One use: the file counts as delivered only once the stored copy is gone. A retry with the
      // same clientRequestId gets the file the first call wrote and finishes that removal.
      const removeStored = removeLogged(storeName(ref)).pipe(
        Effect.flatMap((removed) =>
          removed ? Effect.succeed(file) : new SecretRequestError({ reason: "consume_failed" }),
        ),
      );
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        return yield* removeStored;
      }
      // The stored value goes only after the file is complete, so a failed write can retry.
      const value = yield* useRef({ ref, threadId: input.threadId });
      const partial = `${file}.partial`;
      yield* fileSystem.makeDirectory(filesDir, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(fileSystem.chmod(filesDir, 0o700)),
        Effect.andThen(fileSystem.remove(partial, { force: true })),
        // `wx` never follows or replaces an existing path.
        Effect.andThen(
          fileSystem.writeFile(partial, new TextEncoder().encode(value), {
            flag: "wx",
            mode: 0o600,
          }),
        ),
        Effect.andThen(fileSystem.rename(partial, file)),
        Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
      );
      return yield* removeStored;
    }).pipe(fileLock.withPermits(1));
  });

  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(decoded) && now - decoded.value.savedAt <= SECRET_REF_TTL_MS) continue;
      if (yield* removeLogged(name)) removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );
  const sweepExpiredFiles = Effect.gen(function* () {
    if (filesDir === undefined || !(yield* fileSystem.exists(filesDir))) return;
    const now = yield* Clock.currentTimeMillis;
    let removed = 0;
    for (const name of yield* fileSystem.readDirectory(filesDir)) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const file = path.join(filesDir, name);
      const { mtime } = yield* fileSystem.stat(file);
      if (Option.exists(mtime, (time) => now - time.getTime() <= SECRET_FILE_TTL_MS)) continue;
      yield* fileSystem.remove(file);
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret files", cause)),
    Effect.withSpan("SecretRequests.sweepExpiredFiles"),
  );
  const sweep = Effect.andThen(sweepExpired, sweepExpiredFiles);
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 minute"),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );

  return SecretRequests.of({ answer, savedRef, use, saveToFile });
});

export const layer = Layer.effect(SecretRequests, make);
