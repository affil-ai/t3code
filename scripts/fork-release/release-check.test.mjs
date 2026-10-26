import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCutoverTime,
  assertIdle,
  assertFreshMigration,
  validateManifest,
  verifyArtifacts,
} from "./release-check.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const commit = "a".repeat(40);
const version = "0.1.0-stable.fork.60";
function manifest() {
  return {
    schema: 1,
    repository: "affil-ai/t3code",
    commit,
    version,
    artifacts: ["linux-x64", "darwin-arm64"].map((platform) => ({
      platform,
      commit,
      version,
      path: `/unused/${platform}`,
      bytes: 1,
      sha256: "b".repeat(64),
    })),
  };
}
test("cutover refuses early and invalid dates; permits exact boundary", () => {
  assert.throws(() => assertCutoverTime(new Date("2026-10-19T07:59:59Z")));
  assert.throws(() => assertCutoverTime(new Date("invalid")));
  assert.doesNotThrow(() => assertCutoverTime(new Date("2026-10-19T08:00:00Z")));
});
test("idle fails closed for missing state, busy state, and malformed counts", () => {
  const idle = { running: 0, starting: 0, queued: 0, waiting: 0 };
  assert.doesNotThrow(() => assertIdle(idle));
  for (const state of Object.keys(idle)) {
    assert.throws(() => assertIdle({ ...idle, [state]: 1 }));
    assert.throws(() => assertIdle({ ...idle, [state]: undefined }));
    assert.throws(() => assertIdle({ ...idle, [state]: "0" }));
  }
  assert.throws(() => assertIdle(null));
});
test("migration rejects stale source and retries after canonical migration", () => {
  assert.doesNotThrow(() =>
    assertFreshMigration({ phase: "prepared", sourceCommit: commit }, commit),
  );
  assert.throws(() =>
    assertFreshMigration({ phase: "prepared", sourceCommit: commit }, "b".repeat(40)),
  );
  assert.throws(() => assertFreshMigration({ phase: "published", sourceCommit: commit }, commit));
});
test("paired artifacts require identical commit and version", () => {
  assert.doesNotThrow(() => validateManifest(manifest()));
  for (const field of ["commit", "version", "sha256", "bytes", "platform"]) {
    const value = manifest();
    value.artifacts[1][field] = "invalid";
    assert.throws(() => validateManifest(value));
  }
  const duplicate = manifest();
  duplicate.artifacts[1].platform = "linux-x64";
  assert.throws(() => validateManifest(duplicate));
});
test("a Linux-only release carries exactly one Linux artifact and says so", () => {
  const linux = {
    platform: "linux-x64",
    commit: "a".repeat(40),
    version: "0.1.0-stable.fork.74",
    path: "/tmp/t3.tar.gz",
    bytes: 1,
    sha256: "b".repeat(64),
  };
  const manifest = {
    schema: 1,
    repository: "affil-ai/t3code",
    commit: linux.commit,
    version: linux.version,
    scope: "linux-only",
    artifacts: [linux],
  };
  validateManifest(manifest);
  assert.throws(() => validateManifest({ ...manifest, scope: undefined }), /one Linux and one Mac/);
  assert.throws(() => validateManifest({ ...manifest, scope: "mac-only" }), /scope/);
  assert.throws(
    () => validateManifest({ ...manifest, artifacts: [{ ...linux, platform: "darwin-arm64" }] }),
    /Linux-only/,
  );
});

test("streamed verification catches altered bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-release-test-"));
  try {
    const value = manifest();
    for (const artifact of value.artifacts) {
      artifact.path = join(directory, artifact.platform);
      await writeFile(artifact.path, "a");
      artifact.sha256 = createHash("sha256").update("a").digest("hex");
    }
    await verifyArtifacts(value);
    await writeFile(value.artifacts[0].path, "b");
    await assert.rejects(verifyArtifacts(value), /checksum/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
