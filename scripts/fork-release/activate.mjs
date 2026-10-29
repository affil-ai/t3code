#!/usr/bin/env node
/* oxlint-disable t3code/no-global-process-runtime -- standalone host installer, not Effect application code */
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
const fs = NodeFSP;
const { createReadStream } = NodeFS;
const { createServer } = NodeHttp;
const { homedir } = NodeOS;
const { basename, join, resolve } = NodePath;
const { pathToFileURL } = NodeURL;
const { createHash } = NodeCrypto;
import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
import {
  assertReleaseIdle,
  atomicJson,
  checkDeploy,
  jobPath,
  readJson,
  releasePolicy,
  run,
  stateRoot,
  validateRequest,
  withLock,
  workloadCounts,
} from "./release.mjs";
import { assertIdle } from "./release-check.mjs";
import { execute } from "./transport.mjs";
import { publishWeb, verifyWeb } from "./web.mjs";

const home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const app = "/Applications/T3 Work.app";
const platform = `${process.platform}-${process.arch}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function assertForwardVersion(current, target) {
  const a = /^(.+)\.fork\.(\d+)$/.exec(current);
  const b = /^(.+)\.fork\.(\d+)$/.exec(target);
  if (!a || !b || a[1] !== b[1] || Number(b[2]) < Number(a[2])) {
    throw Error("Different release train or downgrade requires a new review");
  }
}

export async function installedVersion() {
  return process.platform === "darwin"
    ? run("/usr/libexec/PlistBuddy", [
        "-c",
        "Print :CFBundleShortVersionString",
        `${app}/Contents/Info.plist`,
      ])
    : (await readJson(join(home, "runtime/service-state.json"))).activeVersion;
}

function schemaFingerprint() {
  const schema = run("sqlite3", [
    "-readonly",
    "-cmd",
    ".timeout 5000",
    join(home, "userdata/statev2.sqlite"),
    "select type,name,coalesce(sql,'') from sqlite_schema where name not like 'sqlite_%' order by type,name;",
  ]);
  return createHash("sha256").update(schema).digest("hex");
}

/** Only schema-neutral updates are automated. Review other changes separately; never restore live data. */
export function validateCompatibilityReview(review, baselineCommit, commit, diff) {
  const digest = createHash("sha256").update(diff).digest("hex");
  if (
    review?.baselineCommit !== baselineCommit ||
    review?.commit !== commit ||
    review?.serverContractsDiffSha256 !== digest ||
    !review?.migrationEvidence?.trim() ||
    !review?.protocolEvidence?.trim() ||
    !review?.rollbackPlan?.trim()
  )
    throw Error(`Database/protocol review missing or stale; exact diff SHA-256: ${digest}`);
  return {
    baselineCommit,
    commit,
    serverContractsDiffSha256: digest,
    migrationEvidence: review.migrationEvidence,
    protocolEvidence: review.protocolEvidence,
    rollbackPlan: review.rollbackPlan,
  };
}

/** Source commit of the installed runtime, from its own installed receipt. */
export async function installedCommit() {
  const version = await installedVersion();
  const receipt = await readJson(join(jobPath(version), `${platform}-installed.json`)).catch(
    () => null,
  );
  if (receipt?.version !== version || !/^[a-f0-9]{40}$/.test(receipt?.commit ?? ""))
    throw Error(`No installed receipt for ${version}; pass --baseline INSTALLED_SOURCE_SHA`);
  return receipt.commit;
}

/** `qualify VERSION [--baseline SHA] [--shared-diff DIGEST] [--review PATH]`. */
export function parseQualifyArgs(args) {
  const [version, ...rest] = args;
  const options = { version };
  const positional = [];
  const flags = { "--baseline": "baseline", "--shared-diff": "sharedDiff", "--review": "review" };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!flags[arg]) throw Error(`Unknown option ${arg}`);
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw Error(`${arg} needs a value`);
    options[flags[arg]] = value;
  }
  // The Mac worker still passes `BASELINE [DIGEST]` positionally.
  if (positional.length > 2)
    throw Error("Pass the compatibility review as --review PATH, not a positional argument");
  if (positional[0]) options.baseline ??= positional[0];
  if (positional[1]) options.sharedDiff ??= positional[1];
  if (!version) throw Error(qualifyUsage);
  return options;
}

const qualifyUsage =
  "Usage: activate.mjs qualify VERSION [--baseline INSTALLED_SHA] [--shared-diff DIGEST] [--review PATH]";

export async function qualify(version, baselineCommit, reviewedSharedDiff, reviewPath) {
  const request = validateRequest(await readJson(join(jobPath(version), "request.json")));
  baselineCommit ??= await installedCommit();
  if (!/^[a-f0-9]{40}$/.test(baselineCommit ?? ""))
    throw Error("Full installed baseline source required");
  const defaultReview = join(jobPath(version), "compatibility-review.json");
  run("git", ["merge-base", "--is-ancestor", baselineCommit, request.commit]);
  const changes = run("git", [
    "diff",
    baselineCommit,
    request.commit,
    "--",
    "apps/server/src",
    "packages/contracts/src",
  ]);
  let compatibilityReview = null;
  if (changes) {
    const review = await readJson(reviewPath ?? defaultReview).catch(() => null);
    try {
      compatibilityReview = validateCompatibilityReview(
        review,
        baselineCommit,
        request.commit,
        changes,
      );
    } catch (error) {
      throw Error(
        `${error.message}. Review \`git diff ${baselineCommit} ${request.commit} -- apps/server/src packages/contracts/src\`, ` +
          `then write ${reviewPath ?? defaultReview} with baselineCommit, commit, serverContractsDiffSha256, ` +
          `migrationEvidence, protocolEvidence, and rollbackPlan, and run qualify again`,
        { cause: error },
      );
    }
  }
  const sharedDiff = run("git", [
    "diff",
    baselineCommit,
    request.commit,
    "--",
    "packages/shared/src",
  ]);
  const sharedDiffSha256 = createHash("sha256").update(sharedDiff).digest("hex");
  if (sharedDiff && reviewedSharedDiff !== sharedDiffSha256) {
    throw Error(
      `Review the shared-source diff, then pass --shared-diff ${sharedDiffSha256} to qualify`,
    );
  }
  const current = await installedVersion();
  assertForwardVersion(current, version);
  const qualification = {
    ...request,
    platform,
    previousVersion: current,
    baselineCommit,
    schemaFingerprint: schemaFingerprint(),
    sharedDiffSha256: sharedDiff ? sharedDiffSha256 : null,
    compatibilityReview,
    rollback:
      compatibilityReview?.rollbackPlan ??
      "Server/contracts unchanged; shared changes reviewed; preserve data and retain prior runtime",
  };
  if (process.platform === "linux") {
    qualification.officeRelease = await fs.realpath("/opt/office-t3-worker-current");
    await officeCheck(version, qualification.officeRelease);
  }
  await atomicJson(join(jobPath(version), `${platform}-qualification.json`), qualification);
  return qualification;
}

async function officeCheck(version, expectedRelease) {
  const current = await fs.realpath("/opt/office-t3-worker-current");
  if (current !== expectedRelease) throw Error("Office worker changed; qualify again");
  const pin = pathToFileURL(join(current, "apps/office/services/t3-worker/src/pin.ts")).href;
  await execute(process.execPath, [
    "--input-type=module",
    "-e",
    `const p = await import(${JSON.stringify(pin)}); p.assertApprovedT3ServerVersion(${JSON.stringify(version)});`,
  ]);
  run("systemctl", ["is-active", "office-t3-worker.service"]);
  // The shell snapshot of a busy server can take several seconds (13-24 s on a
  // degraded 29 GB database before fork.83); retry before failing.
  await withRetries(3, async () => {
    const response = await fetch("http://127.0.0.1:3779/api/orchestration/shell", {
      headers: { "x-t3-orchestration-protocol": "2" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw Error("Ubuntu orchestration protocol health failed");
    await response.arrayBuffer();
  });
}

export async function withRetries(attempts, operation, wait = pause) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await wait(5000);
    }
  }
}

export async function releaseGuard(version, policy = releasePolicy()) {
  await checkDeploy(version, policy);
  const folder = jobPath(version);
  const manifest = await readJson(join(folder, "manifest.json"));
  if (manifest.scope === "linux-only" && process.platform !== "linux")
    throw Error("Linux-only release; this host keeps its current version");
  if (process.platform === "linux") {
    // A paired release cannot restart Ubuntu while its public web payload is absent.
    await verifyWeb(join(folder, "web"), manifest);
  }
  const qualification = await readJson(join(folder, `${platform}-qualification.json`));
  if (
    qualification.commit !== manifest.commit ||
    qualification.version !== version ||
    qualification.schemaFingerprint !== schemaFingerprint()
  ) {
    throw Error("Qualification changed or database schema moved; review again");
  }
  const current = await installedVersion();
  assertForwardVersion(current, version);
  if (current !== qualification.previousVersion && current !== version)
    throw Error("Installed version changed since qualification");
  // An already migrated fork is always checked against Affil, never the former source.
  run("git", ["fetch", "--no-tags", "https://github.com/affil-ai/t3code.git", "main"]);
  run("git", ["merge-base", "--is-ancestor", manifest.commit, "FETCH_HEAD"]);
  if (process.platform === "linux") await officeCheck(version, qualification.officeRelease);
  return manifest;
}

export async function artifactMirror(artifact, operation) {
  const file = basename(artifact.path);
  const server = createServer((req, res) => {
    if (req.url === `/v${artifact.version}/SHA256SUMS`) {
      res.end(`${artifact.sha256}  ${file}\n`);
    } else if (req.url === `/v${artifact.version}/${file}`) {
      res.setHeader("Content-Length", artifact.bytes);
      createReadStream(artifact.path)
        .on("error", () => res.destroy())
        .pipe(res);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function discovery(version) {
  const port = process.platform === "darwin" ? 3773 : 3779;
  const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw Error("Environment discovery unavailable");
  const data = await response.json();
  if (data.serverVersion !== version || data.orchestrationProtocolVersion !== 2) {
    throw Error("API has not loaded the target version and protocol");
  }
}

/** True when `cgroup` places this process in a T3 provider scope that dies with the server. */
export function insideT3ProviderScope(cgroup) {
  return cgroup
    .split("\n")
    .some((line) => /(^|\/)t3code-[^/]+\.scope(\/|$)/.test(line.split(":").slice(2).join(":")));
}

// The updater stops the server it replaces. It must run from a detached unit
// (handoff.mjs start-linux), never a shell inside T3; this tells it that it is.
const detachedUpdate = { T3_DETACHED_SERVICE_UPDATE: "1" };

async function linuxInstall(version, manifest, log, policy) {
  const artifact = manifest.artifacts.find((entry) => entry.platform === platform);
  await artifactMirror(artifact, async (origin) => {
    const current = await installedVersion();
    const executable = join(home, "runtime/versions", current, "t3");
    // Final observation immediately before invoking the native service updater.
    const counts = assertReleaseIdle(home, policy);
    await log.write(`${JSON.stringify({ current, target: version, counts, policy })}\n`);
    const before = linuxServiceStates();
    await execute(executable, ["update", version, "--base-dir", home, "--yes"], {
      env: { ...process.env, ...detachedUpdate, T3CODE_RELEASE_BASE_URL: origin },
      stdio: ["ignore", log.fd, log.fd],
    });
    // Health is read through the proxy; without it, roll back now rather than
    // spend the full health wait first.
    if (!(await restartCompanions(before, log)))
      throw Error("Server or companion services did not come up after the update");
  });
}

/**
 * Units active before the update that are not active now. The browser proxy has
 * `Requires=t3code.service`, so stopping the server stops it and nothing starts it
 * again; health is read through it.
 */
export function companionsToStart(before, after) {
  return Object.keys(before).filter(
    (unit) => unit !== "t3code.service" && before[unit] === "active" && after[unit] !== "active",
  );
}

const linuxHost = {
  states: () => linuxServiceStates(),
  // --no-block: the proxy's one-shot token refresh has no start timeout, and a
  // hung job must not hold the installer past its own deadline.
  start: (units) =>
    spawnSync("systemctl", ["--user", "start", "--no-block", ...units], { stdio: "ignore" }),
  // The server's own port, not the proxy's: the proxy is one of the companions.
  originAnswers: () =>
    fetch("http://127.0.0.1:3778/.well-known/t3/environment", {
      signal: AbortSignal.timeout(3000),
    }).then(
      (response) => response.ok,
      () => false,
    ),
  now: () => Date.now(),
  pause,
};

/**
 * Starts companions the server stop took down, once the server answers. The
 * proxy also requires the one-shot browser-token refresh, which fails while the
 * server is still opening its database; starting early fails the proxy with
 * result 'dependency' (fork.75). Waits at most 3 minutes for the server and
 * 2 minutes for the companions; returns whether every companion is active.
 */
export async function restartCompanions(before, log, host = linuxHost) {
  const units = companionsToStart(before, host.states());
  if (units.length === 0) return true;
  const serverDeadline = host.now() + 180_000;
  while (!(host.states()["t3code.service"] === "active" && (await host.originAnswers()))) {
    if (host.now() >= serverDeadline) {
      await log.write(`server did not answer within 3 minutes; not starting ${units.join(" ")}\n`);
      return false;
    }
    await host.pause(1000);
  }
  await log.write(`server answering; starting companions: ${units.join(" ")}\n`);
  const deadline = host.now() + 120_000;
  let nextStart = host.now();
  for (;;) {
    const states = host.states();
    const pending = units.filter((unit) => states[unit] !== "active");
    if (pending.length === 0) {
      await log.write("companions active\n");
      return true;
    }
    if (host.now() >= deadline) {
      await log.write(`companions still inactive after 2 minutes: ${pending.join(" ")}\n`);
      return false;
    }
    // Starting a unit whose start job is still queued only merges into that job.
    if (host.now() >= nextStart) {
      host.start(pending);
      nextStart = host.now() + 10_000;
    }
    await host.pause(2000);
  }
}

/** Unit states for the server and its companions; only the server gates health. */
function linuxServiceStates() {
  const units = [
    "t3code.service",
    "t3code-browser-proxy.service",
    "t3-even-terminal.service",
    "t3-feedback-relay.service",
  ];
  const result = spawnSync("systemctl", ["--user", "is-active", ...units], { encoding: "utf8" });
  const states = (result.stdout ?? "").trim().split("\n");
  return Object.fromEntries(units.map((unit, index) => [unit, states[index] ?? "unknown"]));
}

async function awaitVersion(version, attempts, onMiss = async () => {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await discovery(version);
      return true;
    } catch {
      await onMiss(attempt);
      await pause(1000);
    }
  }
  return false;
}

// Older runtimes stay under runtime/versions, so this switches back without a
// download. Qualification's database review is what makes the old binary safe here.
async function linuxRollback(previous, before, log) {
  await log.write(`rolling back to ${previous}\n`);
  await execute(
    join(home, "runtime/versions", previous, "t3"),
    ["update", previous, "--base-dir", home, "--yes", "--allow-downgrade"],
    { env: { ...process.env, ...detachedUpdate }, stdio: ["ignore", log.fd, log.fd] },
  ).catch((error) => log.write(`rollback updater failed: ${error.message}\n`));
  // Never leave the host without a server, even after a partial update.
  if (linuxServiceStates()["t3code.service"] !== "active") {
    spawnSync("systemctl", ["--user", "start", "t3code.service"], { stdio: "ignore" });
  }
  await restartCompanions(before, log);
  return awaitVersion(previous, 120);
}

async function macInstall(version, manifest, log) {
  const folder = jobPath(version);
  const artifact = manifest.artifacts.find((entry) => entry.platform === platform);
  const stage = await fs.mkdtemp(join(folder, "install-"));
  const staged = join(stage, "T3 Work.app");
  const command = (cmd, args) => execute(cmd, args, { stdio: ["ignore", log.fd, log.fd] });
  await command("ditto", ["-x", "-k", artifact.path, stage]);
  await command("codesign", ["--verify", "--deep", "--strict", staged]);
  // Require stable Apple Development signing, not an ad-hoc signature.
  // codesign writes details to stderr; use the designated requirement to validate the signer.
  await command("codesign", ["--verify", "-R", "=anchor apple generic", staged]);
  const candidate = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    `${staged}/Contents/Info.plist`,
  ]);
  if (candidate !== version) throw Error("Staged app version mismatch");
  await log.write("staged and signed\n");
  assertIdle(workloadCounts(home, process.env.T3_FORK_RELEASE_RESTART_THREAD));
  try {
    await command("osascript", ["-e", `tell application "${app}" to quit`]);
    // Never kill a process. Require both app exit and API shutdown before moving bundles.
    let stopped = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const running = run("osascript", ["-e", `application "${app}" is running`]);
      if (running === "false") {
        try {
          await fetch("http://127.0.0.1:3773/.well-known/t3/environment", {
            signal: AbortSignal.timeout(1000),
          });
        } catch {
          stopped = true;
          break;
        }
      }
      await pause(1000);
    }
    if (!stopped) throw Error("App did not quit cleanly; bundle untouched");
    await log.write("quit cleanly\n");
    // A last-moment incoming run must never be silently discarded.
    assertIdle(workloadCounts(home, null, true));
    const previous = join(stage, "previous.app");
    await fs.rename(app, previous);
    try {
      await fs.rename(staged, app);
    } catch (error) {
      await fs.rename(previous, app);
      throw error;
    }
    await atomicJson(join(folder, "mac-installed-bundle.json"), {
      version,
      commit: manifest.commit,
      previous,
    });
    await log.write("installed\n");
    await command(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", app],
    );
    await command("open", [app]);
  } catch (error) {
    // A failed post-quit check must not leave the original app closed.
    // Launch by path without creating another instance; never roll back live data.
    await log.write(`activation stopped: ${error.message}\n`);
    await command("open", [app]).catch(() => {});
    await command("osascript", [
      "-e",
      `tell application "Finder" to open (POSIX file "${app}" as alias)`,
    ]).catch(() => {});
    throw error;
  }
  // Keep the previous bundle. No automatic rollback against a possibly changed database.
}

export async function activate(version, policy = releasePolicy()) {
  return withLock(join(stateRoot, "activation.lock"), async () => {
    const manifest = await releaseGuard(version, policy);
    const folder = jobPath(version);
    const receipt = join(folder, `${platform}-installed.json`);
    if ((await installedVersion()) === version) {
      // Version alone is not provenance. Unknown prior activation needs operator reconciliation.
      const prior = await readJson(receipt);
      if (prior.commit !== manifest.commit) throw Error("Installed provenance mismatch");
      await discovery(version);
      if (process.platform === "linux") await publishWeb(version);
      return prior;
    }
    // Installed runtimes before the updater's own guard cannot refuse this themselves.
    if (
      process.platform === "linux" &&
      insideT3ProviderScope(await fs.readFile("/proc/self/cgroup", "utf8"))
    )
      throw Error(
        "Refusing to restart T3 from inside a T3 agent; run `node scripts/fork-release/handoff.mjs start-linux VERSION`",
      );
    const log = await fs.open(join(folder, `${platform}-install.log`), "a", 0o600);
    const status = join(folder, `${platform}-activation.json`);
    const previousVersion = await installedVersion();
    const servicesBefore = process.platform === "linux" ? linuxServiceStates() : {};
    const started = {
      version,
      commit: manifest.commit,
      previousVersion,
      startedAt: new Date().toISOString(),
    };
    try {
      await atomicJson(status, { ...started, phase: "activating" });
      let healthy = false;
      try {
        if (process.platform === "linux") await linuxInstall(version, manifest, log, policy);
        else if (process.platform === "darwin") await macInstall(version, manifest, log);
        else throw Error("Unsupported host");
        // A large database can take a while to open; the Mac app relaunches faster.
        healthy = await awaitVersion(
          version,
          process.platform === "linux" ? 180 : 30,
          async (attempt) => {
            // LaunchServices can return success before opening a replaced bundle.
            // Retry from Finder without starting a duplicate instance or killing anything.
            if (process.platform === "darwin" && attempt === 10) {
              await execute(
                "osascript",
                ["-e", `tell application "Finder" to open (POSIX file "${app}" as alias)`],
                { stdio: ["ignore", log.fd, log.fd] },
              );
            }
          },
        );
        if (!healthy)
          throw Error("Target installed but API health unverified; inspect private log");
      } catch (error) {
        if (process.platform !== "linux") throw error;
        // Refused before the updater switched anything: the old server is still serving.
        if (
          (await installedVersion()) === previousVersion &&
          (await awaitVersion(previousVersion, 1))
        ) {
          await atomicJson(status, { ...started, phase: "failed", error: error.message });
          throw error;
        }
        await atomicJson(status, { ...started, phase: "rolling-back", error: error.message });
        const restored = await linuxRollback(previousVersion, servicesBefore, log);
        await atomicJson(status, {
          ...started,
          phase: restored ? "rolled-back" : "rollback-failed",
          error: error.message,
          services: linuxServiceStates(),
          at: new Date().toISOString(),
        });
        throw Error(
          restored
            ? `${error.message}; rolled back to ${previousVersion}, which is serving`
            : `${error.message}; rollback to ${previousVersion} unverified, inspect the server now`,
          { cause: error },
        );
      }
      await log.write("relaunched; target API version and protocol verified\n");
      const result = {
        version,
        commit: manifest.commit,
        platform,
        previousVersion,
        artifacts: manifest.artifacts.map(({ platform, sha256 }) => ({ platform, sha256 })),
        ...(process.platform === "linux" ? { services: linuxServiceStates() } : {}),
        phase: "installed",
        verifiedAt: new Date().toISOString(),
      };
      await atomicJson(status, { ...started, phase: "installed", at: result.verifiedAt });
      await atomicJson(receipt, result);
      if (process.platform === "linux") await publishWeb(version);
      return result;
    } finally {
      await log.close();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, version] = process.argv.slice(2);
  (command === "qualify"
    ? Promise.resolve()
        .then(() => parseQualifyArgs(process.argv.slice(3)))
        .then(({ version, baseline, sharedDiff, review }) =>
          qualify(version, baseline, sharedDiff, review),
        )
    : command === "check"
      ? releaseGuard(version).then(({ version, commit }) => ({ version, commit }))
      : command === "install"
        ? activate(version)
        : Promise.reject(Error(`${qualifyUsage} | check VERSION | install VERSION`))
  )
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
