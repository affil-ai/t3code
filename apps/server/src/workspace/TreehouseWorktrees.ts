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
    // fork: treehouse-pool-full
    if (this.operation === "pool-full")
      return "Every agent worktree in the pool is leased, so a new one cannot be allocated.";
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
    readonly release: (
      path: string,
      expectedThreadId?: ThreadId,
      /**
       * fork: treehouse-merge-ref — the caller confirmed this exact commit's pull request
       * merged, so a squash merge that left HEAD outside the base branch loses nothing.
       */
      mergedHead?: string,
    ) => Effect.Effect<boolean, TreehouseWorktreeError>;
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

// fork: treehouse-env-copies
/**
 * An ignored entry whose removal loses nothing the main checkout does not still hold: an exact
 * copy of a checkout file (a setup script's .env copy), an empty folder, or a TypeScript build
 * cache. Anything else, or anything that cannot be read, is kept.
 */
export const disposableIgnoredEntry = Effect.fn("TreehouseWorktrees.disposableIgnoredEntry")(
  function* (worktree: string, checkout: string, entry: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (entry.endsWith("/")) {
      const children = yield* fs.readDirectory(path.join(worktree, entry));
      return children.length === 0;
    }
    if (entry.endsWith(".tsbuildinfo")) return true;
    const original = path.join(checkout, entry);
    if (!(yield* fs.exists(original))) return false;
    const [copy, source] = yield* Effect.all([
      fs.readFile(path.join(worktree, entry)),
      fs.readFile(original),
    ]);
    return copy.length === source.length && copy.every((byte, index) => byte === source[index]);
  },
  Effect.orElseSucceed(() => false),
);

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
        rows[0] === undefined ? Effect.succeed(null) : Schema.decodeEffect(binding)(rows[0]),
      ),
    );
  const writeBinding = (value: Binding) =>
    sql`
    INSERT INTO treehouse_thread_lease (thread_id,cwd,path,lease_id,merge_ref,active)
    VALUES (${value.thread_id},${value.cwd},${value.path},${value.lease_id},${value.merge_ref},${value.active})
    ON CONFLICT(thread_id) DO UPDATE SET cwd=excluded.cwd,path=excluded.path,
      lease_id=excluded.lease_id,merge_ref=excluded.merge_ref,active=excluded.active
  `.pipe(Effect.asVoid);
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    cwd: string,
    // fork: treehouse-pool-full — names a known failure from its output.
    classify?: (stderr: string) => string | undefined,
  ) =>
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
            : Effect.fail(
                new TreehouseWorktreeError({
                  operation: classify?.(result.stderr) ?? "command",
                }),
              ),
        ),
      );
  const treehouse = (
    args: ReadonlyArray<string>,
    cwd: string,
    classify?: (stderr: string) => string | undefined,
  ) =>
    binary === undefined
      ? Effect.fail(new TreehouseWorktreeError({ operation: "not-configured" }))
      : run(binary, ["--root", poolRoot, ...args], cwd, classify);
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
    // Treehouse accepts a branch, while T3 can pin the fetched origin commit.
    // Resolve before allocation so a moving branch cannot change the start point.
    const startCommit = input.existingBranch
      ? null
      : (yield* run(
          "git",
          ["rev-parse", "--verify", "--end-of-options", input.baseRef + "^{commit}"],
          input.cwd,
        )).trim();
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
        input.existingBranch ? input.baseRef : input.mergeRef,
        ...(input.existingBranch ? [] : ["--branch", input.branch]),
      ],
      input.cwd,
      // fork: treehouse-pool-full — Treehouse refuses a get once max_trees slots are held.
      (stderr) => (/worktrees are in use/.test(stderr) ? "pool-full" : undefined),
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
    else if (startCommit !== null)
      yield* run("git", ["reset", "--hard", startCommit], allocatedPath);
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
    acquire: Effect.fn("TreehouseWorktrees.acquire")(
      function* (input) {
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
      },
      guard,
    ),
    ensure: Effect.fn("TreehouseWorktrees.ensure")(
      function* (input) {
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
      },
      guard,
    ),
    ownsPath: Effect.fn("TreehouseWorktrees.ownsPath")(
      function* (input) {
        const rows =
          yield* sql`SELECT 1 FROM treehouse_thread_lease WHERE path = ${path.resolve(input)} LIMIT 1`;
        return rows.length > 0;
      },
      guard,
    ),
    release: Effect.fn("TreehouseWorktrees.release")(
      function* (input, expectedThreadId, mergedHead) {
        const expected =
          expectedThreadId === undefined ? null : yield* readBinding(expectedThreadId);
        if (expected !== null) {
          if (expected.path !== path.resolve(input))
            return yield* new TreehouseWorktreeError({ operation: "owner-workspace-changed" });
          // A retired owner must not release a slot another thread acquired.
          if (expected.active === 0) return true;
        }
        const rows =
          yield* sql<Binding>`SELECT * FROM treehouse_thread_lease WHERE path = ${path.resolve(input)} AND active = 1`;
        const value = rows[0];
        if (value === undefined) {
          if (expected !== null)
            return yield* new TreehouseWorktreeError({ operation: "lease-owner-changed" });
          const known =
            yield* sql`SELECT 1 FROM treehouse_thread_lease WHERE path = ${path.resolve(input)} LIMIT 1`;
          if (known.length > 0 && expectedThreadId !== undefined)
            return yield* new TreehouseWorktreeError({ operation: "lease-owner-changed" });
          return known.length > 0;
        }
        if (
          expectedThreadId !== undefined &&
          (expected === null || expected.lease_id !== value.lease_id)
        )
          return yield* new TreehouseWorktreeError({ operation: "lease-owner-changed" });
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
          root_thread_id: string | null;
        }>`SELECT thread_id, json_extract(payload_json,'$.lineage.rootThreadId') AS root_thread_id
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND json_extract(payload_json,'$.worktreePath') = ${value.path}`;
        // fork: treehouse-shared-lineage — the holder's delegated tasks may share its slot.
        const holder = slot.lease_holder.slice("t3:".length);
        if (
          references.some(
            (entry) => entry.thread_id !== holder && entry.root_thread_id !== holder,
          )
        )
          return yield* new TreehouseWorktreeError({ operation: "shared-worktree" });
        const runs = yield* sql`SELECT 1 FROM orchestration_v2_projection_runs
      WHERE (thread_id IN (SELECT thread_id FROM treehouse_thread_lease WHERE lease_id = ${value.lease_id})
        OR thread_id IN (SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL AND json_extract(payload_json,'$.worktreePath') = ${value.path}))
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
        // fork: treehouse-env-copies — a setup script's exact copy of a file in the
        // main checkout, an empty folder, or a TypeScript build cache loses nothing.
        const protectedEntries = yield* Effect.filter(
          ignored
            .split("\0")
            .filter((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry)),
          (entry) =>
            disposableIgnoredEntry(value.path, value.cwd, entry).pipe(
              Effect.map((ok) => !ok),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            ),
        );
        if (protectedEntries.length > 0)
          return yield* new TreehouseWorktreeError({ operation: "protected-ignored-files" });
        // fork: treehouse-merge-ref — a local base branch can lag far behind origin, where
        // a branch cut from origin was merged. Either one holding HEAD loses no commits.
        yield* run(
          "git",
          ["merge-base", "--is-ancestor", "HEAD", value.merge_ref],
          value.path,
        ).pipe(
          Effect.catch(() =>
            run(
              "git",
              ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/" + value.merge_ref],
              value.path,
            ),
          ),
          Effect.catch((cause) =>
            mergedHead === undefined
              ? Effect.fail(cause)
              : run("git", ["rev-parse", "--verify", "HEAD"], value.path).pipe(
                  Effect.flatMap((head) =>
                    head.trim() === mergedHead ? Effect.void : Effect.fail(cause),
                  ),
                ),
          ),
        );
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
      },
      guard,
    ),
  });
});

export const layer = Layer.effect(TreehouseWorktrees, make);
