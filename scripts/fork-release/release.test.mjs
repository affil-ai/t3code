/* oxlint-disable t3code/no-global-process-runtime -- standalone host release tests */
import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { validateRequest, saveRequest, withLock, shellQuote, workloadCounts } from "./release.mjs";
import * as NodeChildProcess from "node:child_process";
import { assertIdle } from "./release-check.mjs";
const { test } = NodeTest;
const assert = NodeAssert;
const fs = NodeFSP;
const { join } = NodePath;
const { tmpdir } = NodeOS;
const { spawn, spawnSync } = NodeChildProcess;

const request = {
  schema: 1,
  repository: "affil-ai/t3code",
  commit: "a".repeat(40),
  version: "0.1.0-stable.fork.61",
};

test("request rejects traversal, wrong repository, and abbreviated commits", () => {
  for (const change of [
    { version: "../escape" },
    { commit: "abc" },
    { repository: "volumbe/t3code" },
    { version: "1;exit" },
  ]) {
    assert.throws(() => validateRequest({ ...request, ...change }));
  }
  assert.equal(validateRequest(request), request);
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("workload reads wait for a short SQLite writer lock instead of aborting installation", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "fork-sqlite-lock-"));
  try {
    await fs.mkdir(join(root, "userdata"));
    const database = join(root, "userdata/statev2.sqlite");
    const created = spawnSync("sqlite3", [
      database,
      "create table orchestration_v2_projection_runs(status text,payload_json text);",
    ]);
    assert.equal(created.status, 0);
    const holder = spawn("sqlite3", [database], { stdio: ["pipe", "pipe", "pipe"] });
    const locked = new Promise((resolve) => holder.stdout.once("data", resolve));
    holder.stdin.end("begin exclusive;\n.print locked\n.shell sleep 1\ncommit;\n");
    await locked;
    assert.deepEqual(workloadCounts(root), {
      running: 0,
      starting: 0,
      queued: 0,
      waiting: 0,
      heldQueued: 0,
    });
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test(
  "Mac restart exemption permits only the caller's running turn, never queued or other work",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "fork-caller-test-"));
    const caller = "03f54067-5c5b-4137-9c89-a81864815e2b";
    try {
      await fs.mkdir(join(root, "userdata"));
      const database = join(root, "userdata/statev2.sqlite");
      assert.equal(
        spawnSync("sqlite3", [
          database,
          `create table orchestration_v2_projection_runs(thread_id text,status text,payload_json text);
       insert into orchestration_v2_projection_runs values('${caller}','running','{"status":"running"}');
       insert into orchestration_v2_projection_runs values('other','running','{"status":"running"}');
       insert into orchestration_v2_projection_runs values('${caller}','queued','{"status":"queued"}');`,
        ]).status,
        0,
      );
      const counts = workloadCounts(root, caller);
      assert.equal(counts.running, 1);
      assert.equal(counts.queued, 1);
      assert.throws(() => assertIdle(counts), /Busy/);
      assert.throws(() => workloadCounts(root, "' or 1=1"), /explicit/);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  },
);
test("version reservations are idempotent and cannot point to another commit", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "fork-release-test-"));
  try {
    await saveRequest(root, request);
    assert.deepEqual(await saveRequest(root, request), request);
    await assert.rejects(saveRequest(root, { ...request, commit: "b".repeat(40) }), /reserved/);
    const mode =
      (await fs.stat(join(root, "releases", request.version, "request.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
test("single-writer lock refuses concurrent operations and releases on failure", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "fork-lock-test-"));
  const lock = join(root, "lock");
  try {
    await withLock(lock, async () => {
      await assert.rejects(
        withLock(lock, async () => {}),
        /locked/,
      );
    });
    await assert.rejects(
      withLock(lock, async () => {
        throw Error("build failed");
      }),
      /build failed/,
    );
    await withLock(lock, async () => {});
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("workload reads fail closed and do not create a missing live database", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "fork-workload-test-"));
  try {
    await fs.mkdir(join(root, "userdata"));
    const database = join(root, "userdata/statev2.sqlite");
    assert.throws(() => workloadCounts(root));
    await assert.rejects(fs.stat(database), { code: "ENOENT" });
    const created = spawnSync("sqlite3", [
      database,
      `create table orchestration_v2_projection_runs(status text,payload_json text); insert into orchestration_v2_projection_runs values('queued','{"status":"queued"}');`,
    ]);
    assert.equal(created.status, 0, "sqlite3 is required for workload verification");
    const counts = workloadCounts(root);
    assert.equal(counts.queued, 1);
    assert.throws(() => assertIdle(counts), /Busy/);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("stopped database check reads queued work without creating WAL and rejects sidecars", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "fork-offline-test-"));
  try {
    await fs.mkdir(join(root, "userdata"));
    const database = join(root, "userdata/statev2.sqlite");
    assert.equal(
      spawnSync("sqlite3", [
        database,
        `pragma journal_mode=wal; create table orchestration_v2_projection_runs(status text,payload_json text); insert into orchestration_v2_projection_runs values('queued','{"status":"queued"}');`,
      ]).status,
      0,
    );
    const before = await fs.readFile(database);
    const walBefore = await fs.readFile(`${database}-wal`).catch(() => null);
    assert.equal(workloadCounts(root, null, true).queued, 1);
    assert.deepEqual(await fs.readFile(database), before);
    assert.deepEqual(await fs.readFile(`${database}-wal`).catch(() => null), walBefore);
    await fs.writeFile(`${database}-wal`, "uncheckpointed");
    assert.throws(() => workloadCounts(root, null, true), /WAL state/);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
