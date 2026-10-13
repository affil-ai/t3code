import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TreehouseWorktrees from "./TreehouseWorktrees.ts";

const owner = ThreadId.make("pool-owner");
const child = ThreadId.make("pool-child");
const other = ThreadId.make("pool-other");
type Slot = {
  path: string;
  lease_id: string;
  lease_holder: string;
  branch: string;
  processes: Array<{ pid: number; name: string }>;
};

const fixture = <A, E>(
  test: (input: {
    pool: TreehouseWorktrees.TreehouseWorktrees["Service"];
    slots: Array<Slot>;
    commands: Array<ProcessRunner.ProcessRunInput>;
    cwd: string;
    restart: Effect.Effect<TreehouseWorktrees.TreehouseWorktrees["Service"]>;
    setChanges: (input: {
      dirty?: boolean;
      ignored?: string;
      unmerged?: boolean;
      lowDisk?: boolean;
    }) => void;
  }) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pool-test-" });
    const baseDir = directory + "/t3";
    const slots: Array<Slot> = [];
    const commands: Array<ProcessRunner.ProcessRunInput> = [];
    let dirty = false;
    let ignored = "";
    let unmerged = false;
    let lowDisk = false;
    let sequence = 0;
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.sync(() => {
          commands.push(input);
          const args = input.args;
          let stdout = "";
          let code = 0;
          if (input.command === "/test/treehouse") {
            const verb = args[2];
            if (verb === "get") {
              sequence++;
              const branchIndex = args.indexOf("--branch");
              const slot: Slot = {
                path:
                  baseDir +
                  "/worktrees/pool/.treehouse/repository/" +
                  sequence +
                  "/repo-" +
                  sequence,
                lease_id: "lease-" + sequence,
                lease_holder: args[args.indexOf("--lease-holder") + 1] ?? "",
                branch: branchIndex < 0 ? "main" : (args[branchIndex + 1] ?? ""),
                processes: [],
              };
              slots.push(slot);
              stdout = JSON.stringify(slot);
            } else if (verb === "status") stdout = JSON.stringify(slots);
            else if (verb === "return") {
              const slot = slots.find((entry) => entry.path === args[3]);
              if (slot === undefined || slot.lease_id !== args[args.indexOf("--if-lease-id") + 1])
                code = 1;
              else {
                slot.lease_id = "";
                slot.lease_holder = "";
                slot.branch = "main";
              }
            } else throw new Error("Unexpected Treehouse command");
          } else if (input.command === "df") {
            stdout =
              "Filesystem 1024-blocks Used Available Capacity Mounted on\n/test 100000000 1000000 " +
              (lowDisk ? 1000 : 50000000) +
              " 1% /\n";
          } else if (input.command === "git") {
            if (args[0] === "switch") {
              const slot = slots.find((entry) => entry.path === input.cwd);
              if (slot === undefined) code = 1;
              else slot.branch = args[1] ?? "";
            } else if (args.includes("status")) stdout = dirty ? " M source.ts\n" : "";
            else if (args.includes("ls-files")) stdout = ignored;
            else if (args[0] === "merge-base") code = unmerged ? 1 : 0;
            else throw new Error("Unexpected Git command");
          } else throw new Error("Unexpected command");
          return {
            code: ChildProcessSpawner.ExitCode(code),
            stdout,
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const sql = yield* SqlClient.SqlClient;
    const context = yield* Effect.context<
      SqlClient.SqlClient | FileSystem.FileSystem | Path.Path
    >();
    yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, deleted_at TEXT, payload_json TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)`;
    const poolLayer = TreehouseWorktrees.layer.pipe(
      Layer.provide(ServerConfig.layerTest(directory, baseDir)),
      Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
    );
    return yield* Effect.gen(function* () {
      const pool = yield* TreehouseWorktrees.TreehouseWorktrees;
      return yield* test({
        pool,
        slots,
        commands,
        cwd: directory,
        restart: TreehouseWorktrees.TreehouseWorktrees.pipe(
          Effect.provide(Layer.fresh(poolLayer)),
          Effect.provide(context),
          Effect.scoped,
          Effect.orDie,
        ),
        setChanges: (changes) => {
          dirty = changes.dirty ?? false;
          lowDisk = changes.lowDisk ?? false;
          ignored = changes.ignored ?? "";
          unmerged = changes.unmerged ?? false;
        },
      });
    }).pipe(
      Effect.provide(poolLayer),
      Effect.provideService(HostProcess.Environment, { T3CODE_TREEHOUSE_BIN: "/test/treehouse" }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  );

const acquire = (
  pool: TreehouseWorktrees.TreehouseWorktrees["Service"],
  cwd: string,
  threadId = owner,
) =>
  pool.acquire({ threadId, cwd, baseRef: "main", branch: "feature/" + threadId, mergeRef: "main" });

describe("durable Treehouse workspaces", () => {
  it.effect("restores the same held lease after the pool controller restarts", () =>
    fixture(({ pool, cwd, restart, commands }) =>
      Effect.gen(function* () {
        const path = yield* acquire(pool, cwd);
        const reloaded = yield* restart;
        expect(yield* acquire(reloaded, cwd)).toBe(path);
        expect(commands.filter((input) => input.args.includes("get"))).toHaveLength(1);
      }),
    ),
  );

  it.effect("stops allocating before builds can consume the last disk space", () =>
    fixture(({ pool, cwd, setChanges, commands }) =>
      Effect.gen(function* () {
        setChanges({ lowDisk: true });
        const result = yield* acquire(pool, cwd).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(commands.some((input) => input.args.includes("get"))).toBe(false);
      }),
    ),
  );
  it.effect("keeps one lease for retries and paused chats, and shares it with a child", () =>
    fixture(({ pool, cwd, commands }) =>
      Effect.gen(function* () {
        const path = yield* acquire(pool, cwd);
        expect(yield* acquire(pool, cwd)).toBe(path);
        expect(
          yield* pool.ensure({
            threadId: owner,
            rootThreadId: owner,
            cwd,
            worktreePath: path,
            branch: "feature/" + owner,
          }),
        ).toBe(path);
        expect(
          yield* pool.ensure({
            threadId: child,
            rootThreadId: owner,
            cwd,
            worktreePath: path,
            branch: "feature/" + owner,
          }),
        ).toBe(path);
        expect(
          yield* pool.ensure({
            threadId: child,
            rootThreadId: owner,
            cwd,
            worktreePath: path,
            branch: "feature/" + owner,
          }),
        ).toBe(path);
        expect(commands.filter((input) => input.args.includes("get"))).toHaveLength(1);
        expect(commands.some((input) => input.args.includes("return"))).toBe(false);
      }),
    ),
  );

  it.effect("returns a finished lease and restores the branch in a newly owned slot", () =>
    fixture(({ pool, cwd, commands }) =>
      Effect.gen(function* () {
        const oldPath = yield* acquire(pool, cwd);
        yield* pool.ensure({
          threadId: child,
          rootThreadId: owner,
          cwd,
          worktreePath: oldPath,
          branch: "feature/" + owner,
        });
        expect(yield* pool.release(oldPath)).toBe(true);
        const nextPath = yield* pool.ensure({
          threadId: owner,
          rootThreadId: owner,
          cwd,
          worktreePath: oldPath,
          branch: "feature/" + owner,
        });
        expect(nextPath).not.toBe(oldPath);
        expect(
          yield* pool.ensure({
            threadId: child,
            rootThreadId: owner,
            cwd,
            worktreePath: oldPath,
            branch: "feature/" + owner,
          }),
        ).toBe(nextPath);
        const returned = commands.find((input) => input.args.includes("return"));
        expect(returned?.args).toContain("--if-lease-id");
        expect(returned?.args).not.toContain("--force");
        expect(commands.filter((input) => input.args.includes("get"))).toHaveLength(2);
      }),
    ),
  );

  it.effect.each([
    "dirty",
    "ignored",
    "unmerged",
    "process",
    "changed-lease",
    "active-run",
    "shared",
  ] as const)("preserves a slot with %s and never calls return", (reason) =>
    fixture(({ pool, cwd, commands, slots, setChanges }) =>
      Effect.gen(function* () {
        const path = yield* acquire(pool, cwd);
        const sql = yield* SqlClient.SqlClient;
        const slot = slots[0];
        if (slot === undefined) throw new Error("Missing leased fixture");
        if (reason === "dirty") setChanges({ dirty: true });
        if (reason === "ignored") setChanges({ ignored: ".env\0" });
        if (reason === "unmerged") setChanges({ unmerged: true });
        if (reason === "process") slot.processes.push({ pid: 123, name: "agent" });
        if (reason === "changed-lease") slot.lease_id = "somebody-elses-lease";
        if (reason === "active-run")
          yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES (${owner},'running')`;
        if (reason === "shared") {
          const payload = JSON.stringify({ worktreePath: path });
          yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${owner},NULL,${payload}),(${child},NULL,${payload})`;
        }
        expect((yield* pool.release(path).pipe(Effect.result))._tag).toBe("Failure");
        expect(commands.some((input) => input.args.includes("return"))).toBe(false);
      }),
    ),
  );

  it.effect("refuses a stale or unrelated chat instead of entering another lease", () =>
    fixture(({ pool, cwd, slots }) =>
      Effect.gen(function* () {
        const path = yield* acquire(pool, cwd);
        expect(
          (yield* pool
            .ensure({
              threadId: other,
              rootThreadId: other,
              cwd,
              worktreePath: path,
              branch: "feature/" + owner,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const slot = slots[0];
        if (slot === undefined) throw new Error("Missing leased fixture");
        slot.lease_id = "another-lease";
        expect(
          (yield* pool
            .ensure({
              threadId: owner,
              rootThreadId: owner,
              cwd,
              worktreePath: path,
              branch: "feature/" + owner,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
  );

  it.effect("leaves ordinary worktrees outside the pool", () =>
    fixture(({ pool, cwd, commands }) =>
      Effect.gen(function* () {
        expect(
          yield* pool.ensure({
            threadId: owner,
            rootThreadId: owner,
            cwd,
            worktreePath: cwd + "/existing",
            branch: "main",
          }),
        ).toBeNull();
        expect(yield* pool.release(cwd + "/existing")).toBe(false);
        expect(commands).toHaveLength(0);
      }),
    ),
  );
});
