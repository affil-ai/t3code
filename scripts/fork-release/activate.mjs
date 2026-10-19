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
import {
  atomicJson,
  checkDeploy,
  jobPath,
  readJson,
  run,
  stateRoot,
  validateRequest,
  withLock,
  workloadCounts,
} from "./release.mjs";
import { assertIdle } from "./release-check.mjs";
import { execute } from "./transport.mjs";

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

export async function qualify(version, baselineCommit, reviewedSharedDiff, reviewPath) {
  const request = validateRequest(await readJson(join(jobPath(version), "request.json")));
  if (!/^[a-f0-9]{40}$/.test(baselineCommit ?? ""))
    throw Error("Full installed baseline source required");
  run("git", ["merge-base", "--is-ancestor", baselineCommit, request.commit]);
  const changes = run("git", [
    "diff",
    baselineCommit,
    request.commit,
    "--",
    "apps/server/src",
    "packages/contracts/src",
  ]);
  const compatibilityReview = changes
    ? validateCompatibilityReview(
        reviewPath ? await readJson(reviewPath) : null,
        baselineCommit,
        request.commit,
        changes,
      )
    : null;
  const sharedDiff = run("git", [
    "diff",
    baselineCommit,
    request.commit,
    "--",
    "packages/shared/src",
  ]);
  const sharedDiffSha256 = createHash("sha256").update(sharedDiff).digest("hex");
  if (sharedDiff && reviewedSharedDiff !== sharedDiffSha256) {
    throw Error(`Review the shared-source diff, then pass its exact digest: ${sharedDiffSha256}`);
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
  const response = await fetch("http://127.0.0.1:3779/api/orchestration/shell", {
    headers: { "x-t3-orchestration-protocol": "2" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Error("Ubuntu orchestration protocol health failed");
  await response.arrayBuffer();
}

export async function releaseGuard(version) {
  await checkDeploy(version);
  const folder = jobPath(version);
  const manifest = await readJson(join(folder, "manifest.json"));
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

async function linuxInstall(version, manifest, log) {
  const artifact = manifest.artifacts.find((entry) => entry.platform === platform);
  await artifactMirror(artifact, async (origin) => {
    const current = await installedVersion();
    const executable = join(home, "runtime/versions", current, "t3");
    // Final observation immediately before invoking the native service updater.
    assertIdle(workloadCounts(home));
    await execute(executable, ["update", version, "--base-dir", home, "--yes"], {
      env: { ...process.env, T3CODE_RELEASE_BASE_URL: origin },
      stdio: ["ignore", log.fd, log.fd],
    });
  });
  run("systemctl", [
    "--user",
    "is-active",
    "t3code.service",
    "t3code-browser-proxy.service",
    "t3-even-terminal.service",
    "t3-feedback-relay.service",
  ]);
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

export async function activate(version) {
  return withLock(join(stateRoot, "activation.lock"), async () => {
    const manifest = await releaseGuard(version);
    const folder = jobPath(version);
    const receipt = join(folder, `${platform}-installed.json`);
    if ((await installedVersion()) === version) {
      // Version alone is not provenance. Unknown prior activation needs operator reconciliation.
      const prior = await readJson(receipt);
      if (prior.commit !== manifest.commit) throw Error("Installed provenance mismatch");
      await discovery(version);
      return prior;
    }
    const log = await fs.open(join(folder, `${platform}-install.log`), "a", 0o600);
    try {
      await atomicJson(join(folder, `${platform}-activation.json`), {
        version,
        commit: manifest.commit,
        phase: "activating",
        startedAt: new Date().toISOString(),
      });
      if (process.platform === "linux") await linuxInstall(version, manifest, log);
      else if (process.platform === "darwin") await macInstall(version, manifest, log);
      else throw Error("Unsupported host");
      let healthy = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          await discovery(version);
          healthy = true;
          break;
        } catch {
          // LaunchServices can return success before opening a replaced bundle.
          // Retry from Finder without starting a duplicate instance or killing anything.
          if (process.platform === "darwin" && attempt === 10) {
            await execute(
              "osascript",
              ["-e", `tell application "Finder" to open (POSIX file "${app}" as alias)`],
              { stdio: ["ignore", log.fd, log.fd] },
            );
          }
          await pause(1000);
        }
      }
      if (!healthy) throw Error("Target installed but API health unverified; inspect private log");
      await log.write("relaunched; target API version and protocol verified\n");
      const result = {
        version,
        commit: manifest.commit,
        platform,
        artifacts: manifest.artifacts.map(({ platform, sha256 }) => ({ platform, sha256 })),
        phase: "installed",
        verifiedAt: new Date().toISOString(),
      };
      await atomicJson(receipt, result);
      return result;
    } finally {
      await log.close();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, version, baseline, reviewedSharedDiff, reviewPath] = process.argv.slice(2);
  (command === "qualify"
    ? qualify(version, baseline, reviewedSharedDiff, reviewPath)
    : command === "check"
      ? releaseGuard(version).then(({ version, commit }) => ({ version, commit }))
      : command === "install"
        ? activate(version)
        : Promise.reject(
            Error("Usage: activate.mjs qualify VERSION BASELINE_SHA | install VERSION"),
          )
  )
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
