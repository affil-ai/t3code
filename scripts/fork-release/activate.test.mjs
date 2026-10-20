import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
const test = NodeTest.default;
const assert = NodeAssert.default;
const fs = NodeFSP;
const { tmpdir } = NodeOS;
const { join } = NodePath;
const { createHash } = NodeCrypto;
import { artifactMirror, assertForwardVersion, validateCompatibilityReview } from "./activate.mjs";
import { execute, remoteCommand, sshArgs, verifyReceipt } from "./transport.mjs";
import { xml, startLinux, watchLinux } from "./handoff.mjs";

test("Ubuntu-only handoff rejects invalid release targets before spawning", async () => {
  await assert.rejects(startLinux("../escape"));
  await assert.rejects(watchLinux("../escape"));
});

test("server changes require evidence bound to both commits and the exact diff", () => {
  const baseline = "a".repeat(40),
    commit = "b".repeat(40),
    diff = "add nullable avatar column";
  const review = {
    baselineCommit: baseline,
    commit,
    serverContractsDiffSha256: createHash("sha256").update(diff).digest("hex"),
    migrationEvidence: "Migration replayed twice; existing records preserved.",
    protocolEvidence: "Optional wire field; legacy payload decoded.",
    rollbackPlan: "Retain data; old writers preserve the new nullable column.",
  };
  assert.deepEqual(validateCompatibilityReview(review, baseline, commit, diff), review);
  assert.throws(() => validateCompatibilityReview(null, baseline, commit, diff));
  assert.throws(() => validateCompatibilityReview(review, baseline, "c".repeat(40), diff));
  assert.throws(() => validateCompatibilityReview(review, commit, commit, diff));
  assert.throws(() => validateCompatibilityReview(review, baseline, commit, diff + "!"));
  for (const key of ["migrationEvidence", "protocolEvidence", "rollbackPlan"]) {
    assert.throws(() =>
      validateCompatibilityReview({ ...review, [key]: "" }, baseline, commit, diff),
    );
  }
});

test("activation refuses downgrade and another release train", () => {
  assertForwardVersion("0.1.0-stable.fork.59", "0.1.0-stable.fork.62");
  assertForwardVersion("0.1.0-stable.fork.62", "0.1.0-stable.fork.62");
  assert.throws(() => assertForwardVersion("0.1.0-stable.fork.63", "0.1.0-stable.fork.62"));
  assert.throws(() => assertForwardVersion("0.2.0-stable.fork.1", "0.1.0-stable.fork.62"));
});

test("async installer can download verified bytes from the loopback mirror without deadlock", async () => {
  const folder = await fs.mkdtemp(join(tmpdir(), "t3-mirror-test-"));
  try {
    const path = join(folder, "t3-test-linux-x64.tar.gz");
    const bytes = Buffer.from("fixture archive");
    await fs.writeFile(path, bytes);
    const artifact = {
      path,
      version: "test",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await artifactMirror(artifact, async (origin) => {
      const sums = await (await fetch(`${origin}/vtest/SHA256SUMS`)).text();
      assert.match(sums, new RegExp(artifact.sha256));
      assert.equal((await fetch(`${origin}/etc/passwd`)).status, 404);
      await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `const r = await fetch(${JSON.stringify(`${origin}/vtest/t3-test-linux-x64.tar.gz`)});
         if (await r.text() !== "fixture archive") process.exit(2);`,
      ]);
    });
  } finally {
    await fs.rm(folder, { recursive: true });
  }
});

test("transferred receipts reject wrong commit, size, and corrupt bytes", async () => {
  const folder = await fs.mkdtemp(join(tmpdir(), "t3-transfer-test-"));
  try {
    const path = join(folder, "artifact");
    await fs.writeFile(path, "test");
    const request = {
      schema: 1,
      repository: "affil-ai/t3code",
      version: "0.1.0-stable.fork.62",
      commit: "a".repeat(40),
    };
    const receipt = {
      ...request,
      platform: "linux-x64",
      path,
      bytes: 4,
      sha256: createHash("sha256").update("test").digest("hex"),
    };
    await verifyReceipt(receipt, request);
    await assert.rejects(verifyReceipt({ ...receipt, commit: "b".repeat(40) }, request));
    await assert.rejects(verifyReceipt({ ...receipt, bytes: 5 }, request));
    await fs.writeFile(path, "fail");
    await assert.rejects(verifyReceipt(receipt, request));
  } finally {
    await fs.rm(folder, { recursive: true });
  }
});

test("remote transport rejects SSH options and quotes checkout paths", () => {
  assert.throws(() => sshArgs("-oProxyCommand=anything", ""));
  assert.throws(() => remoteCommand("relative", "queue"));
  assert.match(remoteCommand("/work/it's here", "queue"), /'\\''/);
  assert.equal(xml('a&b<"'), "a&amp;b&lt;&quot;");
});
