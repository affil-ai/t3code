import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateRequest, saveRequest, withLock, shellQuote, workloadCounts } from "./release.mjs";
import { spawnSync } from "node:child_process";
import { assertIdle } from "./release-check.mjs";

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
      "create table orchestration_v2_projection_runs(status text); insert into orchestration_v2_projection_runs values('queued');",
    ]);
    assert.equal(created.status, 0, "sqlite3 is required for workload verification");
    const counts = workloadCounts(root);
    assert.equal(counts.queued, 1);
    assert.throws(() => assertIdle(counts), /Busy/);
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
