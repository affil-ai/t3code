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
import {
  artifactMirror,
  assertForwardVersion,
  companionsToStart,
  insideT3ProviderScope,
  parseQualifyArgs,
  restartCompanions,
  validateCompatibilityReview,
  withRetries,
} from "./activate.mjs";
import { execute, remoteCommand, sshArgs, verifyReceipt } from "./transport.mjs";
import { linuxUnitArgs, parseLinuxOptions, xml, startLinux, watchLinux } from "./handoff.mjs";
import { releasePolicy } from "./release.mjs";

test("Ubuntu-only handoff rejects invalid release targets before spawning", async () => {
  await assert.rejects(startLinux("../escape"));
  await assert.rejects(watchLinux("../escape"));
});

test("installs refuse from a T3 agent scope but run from the detached unit", () => {
  const agent =
    "0::/user.slice/user-1003.slice/user@1003.service/app.slice/app-t3code.slice/app-t3code-agents.slice/t3code-codex-1a2b.scope";
  assert.equal(insideT3ProviderScope(agent), true);
  assert.equal(insideT3ProviderScope(`${agent}/child`), true);
  for (const cgroup of [
    "0::/user.slice/user-1003.slice/user@1003.service/app.slice/t3-fork-release.service",
    "0::/user.slice/user-1003.slice/user@1003.service/app.slice/t3code.service",
    "0::/user.slice/user-1003.slice/session-4.scope",
  ])
    assert.equal(insideT3ProviderScope(cgroup), false, cgroup);
});

test("companions stopped with the server are started again; the server itself is not", () => {
  const before = {
    "t3code.service": "active",
    "t3code-browser-proxy.service": "active",
    "t3-even-terminal.service": "active",
    "t3-feedback-relay.service": "inactive",
  };
  // fork.74: the proxy (Requires=t3code.service) stayed down after the restart.
  const after = {
    ...before,
    "t3code.service": "inactive",
    "t3code-browser-proxy.service": "inactive",
  };
  assert.deepEqual(companionsToStart(before, after), ["t3code-browser-proxy.service"]);
  assert.deepEqual(companionsToStart(before, before), []);
});

test("companions start only after the server answers, and are retried until active", async () => {
  const before = {
    "t3code.service": "active",
    "t3code-browser-proxy.service": "active",
    "t3-even-terminal.service": "active",
    "t3-feedback-relay.service": "active",
  };
  // fork.75: the server unit was active but still opening its database, so the
  // proxy's token refresh failed and the proxy start failed with 'dependency'.
  const fakeHost = (states, { answersAt = 0, startsNeeded = 1 } = {}) => {
    const host = {
      clock: 0,
      starts: [],
      states: () => ({ ...states }),
      originAnswers: async () => host.clock >= answersAt,
      start: (units) => {
        host.starts.push([host.clock, units]);
        if (host.starts.length === startsNeeded) for (const unit of units) states[unit] = "active";
      },
      now: () => host.clock,
      pause: async (ms) => {
        host.clock += ms;
      },
    };
    return host;
  };
  const log = { lines: [], write: async (line) => log.lines.push(line) };
  const down = { ...before, "t3code-browser-proxy.service": "inactive" };

  const slow = fakeHost({ ...down }, { answersAt: 60_000, startsNeeded: 2 });
  assert.equal(await restartCompanions(before, log, slow), true);
  assert.deepEqual(
    slow.starts.map(([at, units]) => [at, units]),
    [
      [60_000, ["t3code-browser-proxy.service"]],
      [70_000, ["t3code-browser-proxy.service"]],
    ],
  );
  assert.match(log.lines.at(-1), /companions active/);

  // A server that never answers fails within the bound without starting anything.
  const silent = fakeHost({ ...down }, { answersAt: Infinity });
  assert.equal(await restartCompanions(before, log, silent), false);
  assert.deepEqual(silent.starts, []);
  assert.ok(silent.clock <= 181_000);

  // A companion that never starts is reported within its bound, not hidden.
  const stuck = fakeHost({ ...down }, { startsNeeded: Infinity });
  assert.equal(await restartCompanions(before, log, stuck), false);
  assert.ok(stuck.clock <= 122_000);
  assert.match(log.lines.at(-1), /still inactive after 2 minutes: t3code-browser-proxy.service/);
});

test("qualify takes named flags and rejects a positional review path", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(parseQualifyArgs(["v"]), { version: "v" });
  assert.deepEqual(parseQualifyArgs(["v", "--baseline", sha, "--review", "/r.json"]), {
    version: "v",
    baseline: sha,
    review: "/r.json",
  });
  // The Mac worker's positional form still works.
  assert.deepEqual(parseQualifyArgs(["v", sha, "digest"]), {
    version: "v",
    baseline: sha,
    sharedDiff: "digest",
  });
  // fork.75: a review path passed positionally was silently ignored.
  assert.throws(() => parseQualifyArgs(["v", sha, "digest", "/r.json"]), /--review PATH/);
  assert.throws(() => parseQualifyArgs(["v", "--review"]), /needs a value/);
  assert.throws(() => parseQualifyArgs(["v", "--force", "x"]), /Unknown option/);
});

test("a slow health probe is retried before failing", async () => {
  let calls = 0;
  const value = await withRetries(
    3,
    async () => {
      if (++calls < 3) throw Error("The operation was aborted due to timeout");
      return "ok";
    },
    async () => {},
  );
  assert.equal(value, "ok");
  calls = 0;
  await assert.rejects(
    withRetries(
      2,
      async () => {
        calls++;
        throw Error("down");
      },
      async () => {},
    ),
    /down/,
  );
  assert.equal(calls, 2);
});

test("the detached Linux unit carries its own environment and the caller's policy", () => {
  const policy = releasePolicy({
    restartThread: "mcp:961cb8d8-a15e-4e16-901f-bd19a9911453",
    approvedInterrupt: "Vivek approved the restart",
  });
  const args = linuxUnitArgs("0.1.0-stable.fork.74", policy, "/state/handoff-linux.log", {
    PATH: "/usr/bin",
    T3CODE_HOME: "/home/u/.t3",
  });
  assert.ok(args.includes("--unit=t3-fork-release.service"));
  assert.ok(args.includes("--collect"));
  assert.ok(args.includes("--setenv=PATH=/usr/bin"));
  assert.ok(args.includes("--setenv=T3CODE_HOME=/home/u/.t3"));
  assert.ok(args.includes("--property=StandardOutput=append:/state/handoff-linux.log"));
  assert.ok(!args.some((arg) => arg.startsWith("--setenv=T3_FORK_RELEASE_STATE")));
  const watch = args.slice(args.indexOf("watch-linux"));
  assert.deepEqual(parseLinuxOptions(watch.slice(2)), {
    restartThread: policy.restartThread,
    approvedInterrupt: policy.approvedInterrupt,
  });
  assert.throws(() => parseLinuxOptions(["--restart-thread"]), /needs a value/);
  assert.throws(() => parseLinuxOptions(["--force", "yes"]), /Unknown option/);
  assert.throws(() => releasePolicy({ restartThread: "x' or 1=1" }), /calling T3 thread/);
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
