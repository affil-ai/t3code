import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

export class TreehouseWorktreeError extends Schema.TaggedError<TreehouseWorktreeError>()(
  "TreehouseWorktreeError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    if (this.operation === "low-disk-space")
      return "At least 20 GiB of free disk space is required to create another worktree.";
    return "Could not safely reuse the agent worktree. Its lease and files were preserved.";
  }
}
const isTreehouseWorktreeError = Schema.is(TreehouseWorktreeError);

export class TreehouseWorktrees extends Context.Service<
  TreehouseWorktrees,
  {
    readonly enabled: boolean;
    readonly acquire: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly baseRef: string;
      readonly branch: string;
      readonly mergeRef: string;
    }) => Effect.Effect<string, TreehouseWorktreeError>;
    /** Null identifies an ordinary Git worktree, outside this pool. */
    readonly ensure: (input: {
      readonly threadId: ThreadId;
      readonly rootThreadId: ThreadId;
      readonly cwd: string;
      readonly worktreePath: string;
      readonly branch: string;
    }) => Effect.Effect<string | null, TreehouseWorktreeError>;
    readonly ownsPath: (path: string) => Effect.Effect<boolean, TreehouseWorktreeError>;
    /** False identifies an ordinary Git worktree. Never force a pool return. */
    readonly release: (path: string) => Effect.Effect<boolean, TreehouseWorktreeError>;
  }
>()("t3/workspace/TreehouseWorktrees") {}

const allocation = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.String,
    lease_id: Schema.String,
    lease_holder: Schema.String,
  }),
);
const status = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      path: Schema.String,
      lease_id: Schema.String,
      lease_holder: Schema.String,
      branch: Schema.String,
      branch_error: Schema.optional(Schema.String),
      recovery_reason: Schema.optional(Schema.String),
      processes: Schema.Array(Schema.Struct({ pid: Schema.Number, name: Schema.String })),
    }),
  ),
);
const binding = Schema.Struct({
  thread_id: ThreadId,
  cwd: Schema.String,
  path: Schema.String,
  lease_id: Schema.String,
  merge_ref: Schema.String,
  active: Schema.Number,
});
type Binding = typeof binding.Type;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const config = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  // This is a host's allocation backend, not a change to a user's global Git.
  const binary = environment.T3CODE_TREEHOUSE_BIN;
  const poolRoot = path.join(config.worktreesDir, "pool");
  const emptyInclude = path.join(config.stateDir, "treehouse-empty-include");
  yield* sql`CREATE TABLE IF NOT EXISTS treehouse_thread_lease (
    thread_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, path TEXT NOT NULL,
    lease_id TEXT NOT NULL, merge_ref TEXT NOT NULL, active INTEGER NOT NULL
  )`;
  const readBinding = (threadId: ThreadId) =>
    sql<Binding>`SELECT * FROM treehouse_thread_lease WHERE thread_id = ${threadId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(null) : Schema.decodeUnknownEffect(binding)(rows[0]),
      ),
    );
  const writeBinding = (value: Binding) =>
    sql`
    INSERT INTO treehouse_thread_lease (thread_id,cwd,path,lease_id,merge_ref,active)
    VALUES (${value.thread_id},${value.cwd},${value.path},${value.lease_id},${value.merge_ref},${value.active})
    ON CONFLICT(thread_id) DO UPDATE SET cwd=excluded.cwd,path=excluded.path,
      lease_id=excluded.lease_id,merge_ref=excluded.merge_ref,active=excluded.active
  `.pipe(Effect.asVoid);
  const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
    runner
      .run({
        command,
        args,
        cwd,
        timeout: "5 minutes",
        maxOutputBytes: 1024 * 1024,
        env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
      })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0 && !result.stdoutTruncated
            ? Effect.succeed(result.stdout)
            : Effect.fail(new TreehouseWorktreeError({ operation: "command" })),
        ),
      );
  const treehouse = (args: ReadonlyArray<string>, cwd: string) =>
    binary === undefined
      ? Effect.fail(new TreehouseWorktreeError({ operation: "not-configured" }))
      : run(binary, ["--root", poolRoot, ...args], cwd);
  const readStatus = (cwd: string) =>
    treehouse(["status", "--json"], cwd).pipe(Effect.flatMap(Schema.decodeUnknownEffect(status)));
  const currentLease = (value: Binding) =>
    readStatus(value.cwd).pipe(
      Effect.flatMap((slots) => {
        const slot = slots.find((entry) => path.resolve(entry.path) === value.path);
        return slot === undefined ||
          slot.lease_id !== value.lease_id ||
          slot.lease_holder !== "t3:" + value.thread_id ||
          slot.branch_error ||
          slot.recovery_reason
          ? Effect.fail(new TreehouseWorktreeError({ operation: "lease-changed" }))
          : Effect.succeed(slot);
      }),
    );
  const allocate = Effect.fn("TreehouseWorktrees.allocate")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly baseRef: string;
    readonly branch: string;
    readonly mergeRef: string;
    readonly existingBranch?: boolean;
  }) {
    yield* fs.makeDirectory(config.stateDir, { recursive: true, mode: 0o700 });
    yield* fs.makeDirectory(poolRoot, { recursive: true, mode: 0o700 });
    const free = yield* run("df", ["-Pk", poolRoot], poolRoot);
    const availableKiB = Number(free.trim().split("\n").at(-1)?.trim().split(/\s+/)[3]);
    // A lease limit bounds checkout count, but does not bound their sizes.
    // Leave room for builds and dependency installs.
    if (!Number.isFinite(availableKiB) || availableKiB < 20 * 1024 * 1024)
      return yield* new TreehouseWorktreeError({ operation: "low-disk-space" });
    if (!(yield* fs.exists(emptyInclude)))
      yield* fs.writeFileString(emptyInclude, "", { mode: 0o600 });
    const result = yield* treehouse(
      [
        "get",
        "--lease",
        "--json",
        "--lease-holder",
        "t3:" + input.threadId,
        "--no-fetch",
        "--unique-leaf",
        "--include-file",
        emptyInclude,
        "--base",
        input.baseRef,
        ...(input.existingBranch ? [] : ["--branch", input.branch]),
      ],
      input.cwd,
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(allocation)));
    const allocatedPath = path.resolve(result.path);
    const root = path.join(poolRoot, ".treehouse") + path.sep;
    if (
      !allocatedPath.startsWith(root) ||
      result.lease_id === "" ||
      result.lease_holder !== "t3:" + input.threadId
    )
      return yield* new TreehouseWorktreeError({ operation: "invalid-allocation" });
    const value: Binding = {
      thread_id: input.threadId,
      cwd: path.resolve(input.cwd),
      path: allocatedPath,
      lease_id: result.lease_id,
      merge_ref: input.mergeRef,
      active: 1,
    };
    // Persist before checkout/progress callbacks. A crash keeps the slot held.
    yield* writeBinding(value);
    if (input.existingBranch) yield* run("git", ["switch", input.branch], allocatedPath);
    const slot = yield* currentLease(value);
    if (slot.branch !== input.branch)
      return yield* new TreehouseWorktreeError({ operation: "branch-changed" });
    return allocatedPath;
  });
  const guard = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      lock.withPermits(1),
      Effect.mapError((cause) =>
        isTreehouseWorktreeError(cause)
          ? cause
          : new TreehouseWorktreeError({ operation: "storage", cause }),
      ),
    );
  return TreehouseWorktrees.of({
    enabled: binary !== undefined,
    acquire: (input) =>
      guard(
        Effect.gen(function* () {
          const existing = yield* readBinding(input.threadId);
          if (existing?.active === 1) {
            const slot = yield* currentLease(existing);
            if (slot.branch !== input.branch || existing.cwd !== path.resolve(input.cwd))
              return yield* new TreehouseWorktreeError({ operation: "ownership-changed" });
            return existing.path;
          }
          const previous = (yield* readStatus(input.cwd)).filter(
            (entry) => entry.lease_holder === "t3:" + input.threadId,
          );
          if (previous.length > 1)
            return yield* new TreehouseWorktreeError({ operation: "ambiguous-lease" });
          const recovered = previous[0];
          if (recovered !== undefined) {
            const recoveredPath = path.resolve(recovered.path);
            if (
              !recoveredPath.startsWith(path.join(poolRoot, ".treehouse") + path.sep) ||
              recovered.lease_id === "" ||
              recovered.branch !== input.branch ||
              recovered.branch_error ||
              recovered.recovery_reason
            )
              return yield* new TreehouseWorktreeError({ operation: "unconfirmed-lease" });
            yield* writeBinding({
              thread_id: input.threadId,
              cwd: path.resolve(input.cwd),
              path: recoveredPath,
              lease_id: recovered.lease_id,
              merge_ref: input.mergeRef,
              active: 1,
            });
            return recoveredPath;
          }
          return yield* allocate(input);
        }),
      ),
    ensure: (input) =>
      guard(
        Effect.gen(function* () {
          let value = yield* readBinding(input.threadId);
          if ((value === null || value.active === 0) && input.rootThreadId !== input.threadId) {
            const root = yield* readBinding(input.rootThreadId);
            if (root?.active === 1 && root.cwd === path.resolve(input.cwd)) {
              const slot = yield* currentLease(root);
              if (slot.branch === input.branch) {
                value = { ...root, thread_id: input.threadId };
                yield* writeBinding(value);
                return root.path;
              }
            }
          }
          if (value === null) {
            const rows =
              yield* sql`SELECT 1 FROM treehouse_thread_lease WHERE path = ${path.resolve(input.worktreePath)} LIMIT 1`;
            if (rows.length > 0)
              return yield* new TreehouseWorktreeError({ operation: "unowned-slot" });
            return null;
          }
          if (value.cwd !== path.resolve(input.cwd))
            return yield* new TreehouseWorktreeError({ operation: "repository-changed" });
          if (value.active === 1) {
            // Aliases use the original lease holder, not their own app thread ID.
            const owners = yield* sql<Binding>`SELECT * FROM treehouse_thread_lease
          WHERE lease_id = ${value.lease_id} AND active = 1`;
            const slots = yield* readStatus(value.cwd);
            const slot = slots.find((entry) => path.resolve(entry.path) === value.path);
            if (
              slot === undefined ||
              slot.lease_id !== value.lease_id ||
              slot.branch !== input.branch ||
              slot.branch_error ||
              slot.recovery_reason ||
              !owners.some((owner) => slot.lease_holder === "t3:" + owner.thread_id)
            )
              return yield* new TreehouseWorktreeError({ operation: "lease-changed" });
            return value.path;
          }
          return yield* allocate({
            threadId: input.threadId,
            cwd: value.cwd,
            baseRef: input.branch,
            branch: input.branch,
            mergeRef: value.merge_ref,
            existingBranch: true,
          });
        }),
      ),
    ownsPath: (input) =>
      guard(
        sql`SELECT 1 FROM treehouse_thread_lease WHERE path = ${path.resolve(input)} LIMIT 1`.pipe(
          Effect.map((rows) => rows.length > 0),
        ),
      ),
    release: (input) =>
      guard(
        Effect.gen(function* () {
          const rows =
            yield* sql<Binding>`SELECT * FROM treehouse_thread_lease WHERE path = ${path.resolve(input)} AND active = 1`;
          const value = rows[0];
          if (value === undefined) {
            const known =
              yield* sql`SELECT 1 FROM treehouse_thread_lease WHERE path = ${path.resolve(input)} LIMIT 1`;
            return known.length > 0;
          }
          const slots = yield* readStatus(value.cwd);
          const slot = slots.find((entry) => path.resolve(entry.path) === value.path);
          if (
            slot === undefined ||
            slot.lease_id !== value.lease_id ||
            slot.processes.length > 0 ||
            slot.branch_error ||
            slot.recovery_reason ||
            !rows.some((owner) => slot.lease_holder === "t3:" + owner.thread_id)
          )
            return yield* new TreehouseWorktreeError({ operation: "busy-or-changed" });
          const references = yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND json_extract(payload_json,'$.worktreePath') = ${value.path}`;
          if (
            references.length > 1 ||
            references.some((entry) => "t3:" + entry.thread_id !== slot.lease_holder)
          )
            return yield* new TreehouseWorktreeError({ operation: "shared-worktree" });
          const runs = yield* sql`SELECT 1 FROM orchestration_v2_projection_runs
        WHERE thread_id IN (SELECT thread_id FROM treehouse_thread_lease WHERE lease_id = ${value.lease_id})
        AND status NOT IN ('completed','cancelled','failed','interrupted') LIMIT 1`;
          if (runs.length > 0)
            return yield* new TreehouseWorktreeError({ operation: "active-run" });
          const changes = yield* run(
            "git",
            [
              "-c",
              "status.showUntrackedFiles=normal",
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
            ],
            value.path,
          );
          if (changes.trim() !== "")
            return yield* new TreehouseWorktreeError({ operation: "local-changes" });
          const ignored = yield* run(
            "git",
            ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
            value.path,
          );
          // Preserve ignored source, credentials and local state. Dependencies are
          // the only ignored directory this adapter permits Treehouse to retain.
          if (
            ignored
              .split("\0")
              .some((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry))
          )
            return yield* new TreehouseWorktreeError({ operation: "protected-ignored-files" });
          yield* run("git", ["merge-base", "--is-ancestor", "HEAD", value.merge_ref], value.path);
          // Treehouse rechecks this exact lease under its own pool lock. No --force,
          // --all, prune, or orphan recovery can affect another thread's slot.
          yield* treehouse(["return", value.path, "--if-lease-id", value.lease_id], value.cwd);
          const after = (yield* readStatus(value.cwd)).find(
            (entry) => path.resolve(entry.path) === value.path,
          );
          if (after === undefined || after.lease_id !== "" || after.processes.length > 0)
            return yield* new TreehouseWorktreeError({ operation: "return-unconfirmed" });
          yield* sql`UPDATE treehouse_thread_lease SET active = 0 WHERE lease_id = ${value.lease_id}`;
          return true;
        }),
      ),
  });
});

export const layer = Layer.effect(TreehouseWorktrees, make);
