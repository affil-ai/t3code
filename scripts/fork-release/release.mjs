#!/usr/bin/env node
// Builds never activate a server or quit the desktop app. Activation is separate.
/* oxlint-disable t3code/no-global-process-runtime -- standalone host build driver */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const { spawnSync } = NodeChildProcess;
const { createHash, randomUUID } = NodeCrypto;
const { createReadStream } = NodeFS;
const fs = NodeFSP;
const { homedir } = NodeOS;
const { dirname, join, resolve } = NodePath;
const { fileURLToPath, pathToFileURL } = NodeURL;
import {
  assertCutoverTime,
  assertIdle,
  validateManifest,
  verifyArtifacts,
} from "./release-check.mjs";
import { classifyWorkload, workloadSql } from "./workload.mjs";

const repository = "https://github.com/affil-ai/t3code.git";
export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const stateRoot = resolve(
  process.env.T3_FORK_RELEASE_STATE ?? join(homedir(), ".local/state/t3-fork-release"),
);

export function validateRequest(request) {
  if (
    request?.schema !== 1 ||
    request.repository !== "affil-ai/t3code" ||
    !/^[a-f0-9]{40}$/.test(request.commit ?? "") ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.fork\.\d+$/.test(request.version ?? "")
  ) {
    throw new Error("Invalid release request");
  }
  return request;
}

export function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'";
}

export async function atomicJson(path, data) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, path);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function withLock(path, operation) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // A crashed owner leaves its lock behind. Retire it (kept for diagnosis) only
    // when its recorded process is gone; a missing owner file may be mid-write.
    const owner = await readJson(join(path, "owner.json")).catch(() => null);
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || processAlive(owner.pid))
      throw new Error("Release is locked; inspect its owner before retrying", { cause: error });
    await fs.rename(path, `${path}-retired-${owner.pid}-${Date.now()}`);
    await fs.mkdir(path, { mode: 0o700 });
  }
  try {
    await fs.writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    return await operation();
  } finally {
    await fs.unlink(join(path, "owner.json"));
    await fs.rmdir(path);
  }
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed; inspect the private build log (exit ${result.status ?? "unknown"})`,
    );
  }
  return (result.stdout ?? "").trim();
}

export async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

export async function digest(path) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest("hex");
}

export function jobPath(version) {
  validateRequest({ schema: 1, repository: "affil-ai/t3code", commit: "a".repeat(40), version });
  return join(stateRoot, "releases", version);
}

export async function saveRequest(root, request) {
  validateRequest(request);
  const folder = join(root, "releases", request.version);
  return withLock(join(folder, "request.lock"), async () => {
    const path = join(folder, "request.json");
    try {
      const old = await readJson(path);
      if (old.commit !== request.commit || old.repository !== request.repository) {
        throw new Error("Version already reserved for another commit");
      }
      return validateRequest(old);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await atomicJson(path, request);
    return request;
  });
}

async function request(commit, version) {
  const value = validateRequest({ schema: 1, repository: "affil-ai/t3code", commit, version });
  run("git", ["fetch", "--no-tags", repository, "main"]);
  run("git", ["merge-base", "--is-ancestor", commit, "FETCH_HEAD"]);
  return saveRequest(stateRoot, { ...value, createdAt: new Date().toISOString() });
}

export function supportsLinuxExecutable(version) {
  const [major, minor] = String(version).replace(/^v/, "").split(".").map(Number);
  return major > 25 || (major === 25 && minor >= 7);
}

// The Linux single executable needs Node 25.7+, newer than the repository engine and
// usually newer than the host default. Use T3_FORK_RELEASE_NODE, this Node, or the
// newest ~/.local/opt/node-v*-linux-x64 install, so builds never need a manual resume.
export function linuxBuildNode(optDir = join(homedir(), ".local/opt")) {
  let installed = [];
  try {
    installed = NodeFS.readdirSync(optDir)
      .filter((name) => /^node-v\d+\.\d+\.\d+-linux-x64$/.test(name))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
      .map((name) => join(optDir, name, "bin/node"));
  } catch {}
  for (const node of [process.env.T3_FORK_RELEASE_NODE, process.execPath, ...installed]) {
    if (!node) continue;
    try {
      if (supportsLinuxExecutable(run(node, ["--version"]))) return node;
    } catch {}
  }
  throw new Error(
    `Linux executable build needs Node 25.7+; set T3_FORK_RELEASE_NODE or install it under ${optDir}`,
  );
}

export async function build(version) {
  const job = jobPath(version);
  const value = validateRequest(await readJson(join(job, "request.json")));
  const platform = `${process.platform}-${process.arch}`;
  if (!["linux-x64", "darwin-arm64"].includes(platform)) throw new Error("Unsupported build host");
  const node = platform === "linux-x64" ? linuxBuildNode() : process.execPath;
  return withLock(join(job, `${platform}.lock`), async () => {
    const record = join(job, `${platform}.json`);
    try {
      const previous = await readJson(record);
      if (
        previous.commit !== value.commit ||
        previous.version !== version ||
        (await digest(previous.path)) !== previous.sha256
      )
        throw new Error("Staged artifact mismatch");
      if (platform === "linux-x64") {
        const { buildWeb } = await import("./web.mjs");
        await buildWeb(version);
      }
      return previous;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const attempt = await fs.mkdtemp(join(job, `${platform}-`));
    const checkout = join(attempt, "source");
    const log = await fs.open(join(attempt, "build.log"), "wx", 0o600);
    try {
      const execute = (command, args, cwd = checkout, env = process.env) =>
        run(command, args, {
          cwd,
          env,
          timeout: 60 * 60 * 1000,
          stdio: ["ignore", log.fd, log.fd],
        });
      execute("git", ["clone", "--no-checkout", "--no-hardlinks", sourceRoot, checkout], attempt);
      execute("git", ["checkout", "--detach", value.commit]);
      if (run("git", ["rev-parse", "HEAD"], { cwd: checkout }) !== value.commit) {
        throw new Error("Checkout commit mismatch");
      }
      const pkg = await readJson(join(checkout, "package.json"));
      if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager))
        throw new Error("Unsupported package manager");
      const env = {
        ...process.env,
        PATH: `${checkout}/node_modules/.bin:${homedir()}/.cargo/bin:${process.env.PATH}`,
        CARGO_BUILD_JOBS: "2",
        TURBO_CONCURRENCY: "2",
      };
      delete env.GITHUB_REPOSITORY;
      delete env.T3CODE_DESKTOP_UPDATE_REPOSITORY;
      execute("npx", ["--yes", pkg.packageManager, "install", "--frozen-lockfile"], checkout, env);
      execute(node, ["scripts/update-release-package-versions.ts", version], checkout, env);
      let artifact;
      if (platform === "linux-x64") {
        execute(
          "cargo",
          [
            "build",
            "--locked",
            "--release",
            "--manifest-path",
            "native/resource-monitor/Cargo.toml",
          ],
          checkout,
          env,
        );
        const monitor = join(attempt, "resource-monitor/linux-x64");
        await fs.mkdir(monitor, { recursive: true });
        await fs.copyFile(
          join(checkout, "native/resource-monitor/target/release/t3-resource-monitor"),
          join(monitor, "t3-resource-monitor"),
        );
        execute("vp", ["run", "--filter", "t3", "build"], checkout, env);
        execute(node, ["apps/server/scripts/cli.ts", "build-exe"], checkout, env);
        execute(
          node,
          [
            "scripts/build-cli-archive.ts",
            "--platform",
            "linux",
            "--arch",
            "x64",
            "--version",
            version,
            "--resource-monitor-dir",
            dirname(monitor),
            "--output-dir",
            attempt,
          ],
          checkout,
          env,
        );
        artifact = join(attempt, `t3-${version}-linux-x64.tar.gz`);
        execute(
          node,
          ["scripts/smoke-cli-archive.ts", "--archive", artifact, "--expect-version", version],
          checkout,
          env,
        );
      } else {
        execute(
          node,
          [
            "scripts/build-desktop-artifact.ts",
            "--platform",
            "mac",
            "--target",
            "dmg",
            "--arch",
            "arm64",
            "--build-version",
            version,
          ],
          checkout,
          env,
        );
        artifact = join(checkout, "release", `T3-Work-${version}-arm64.zip`);
        // Sign before hashing/exchanging. Apple credentials never leave this host.
        const stage = join(attempt, "signed");
        await fs.mkdir(stage);
        execute("ditto", ["-x", "-k", artifact, stage]);
        const app = join(stage, "T3 Work.app");
        execute("codesign", ["--force", "--deep", "--sign", "Apple Development", app]);
        execute("codesign", ["--verify", "--deep", "--strict", app]);
        artifact = join(attempt, `T3-Work-${version}-arm64.zip`);
        execute("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, artifact]);
      }
      if (platform === "linux-x64") {
        const { stageWeb } = await import("./web.mjs");
        await stageWeb(checkout, value, env, log);
      }
      const result = {
        platform,
        commit: value.commit,
        version,
        path: artifact,
        bytes: (await fs.stat(artifact)).size,
        sha256: await digest(artifact),
        phase: "built",
        createdAt: new Date().toISOString(),
      };
      await atomicJson(record, result);
      return result;
    } finally {
      await log.close();
    }
  });
}

/** `linuxOnly` stages an Ubuntu and web release without a Mac artifact; the Mac stays put. */
export async function manifest(version, linuxOnly = false) {
  const folder = jobPath(version);
  const requestValue = validateRequest(await readJson(join(folder, "request.json")));
  const artifacts = [];
  for (const platform of linuxOnly ? ["linux-x64"] : ["linux-x64", "darwin-arm64"]) {
    artifacts.push(await readJson(join(folder, `${platform}.json`)));
  }
  const result = {
    schema: 1,
    repository: requestValue.repository,
    commit: requestValue.commit,
    version,
    ...(linuxOnly ? { scope: "linux-only" } : {}),
    artifacts,
    phase: "staged",
    createdAt: new Date().toISOString(),
  };
  validateManifest(result);
  await atomicJson(join(folder, "manifest.json"), result);
  return result;
}

export function readReleaseDatabase(home, sql, stopped = false) {
  const database = `${home}/userdata/statev2.sqlite`;
  // Only the installer, after confirming both app and API have exited, uses this.
  // Never ignore a WAL: it can contain committed work not in the main file yet.
  const assertNoWal = () => {
    if (NodeFS.existsSync(`${database}-wal`) && NodeFS.statSync(`${database}-wal`).size > 0) {
      throw Error("Stopped database still has WAL state; refuse immutable read");
    }
  };
  if (stopped) assertNoWal();
  const before = stopped ? NodeFS.statSync(database) : null;
  const target = stopped ? `${pathToFileURL(database).href}?mode=ro&immutable=1` : database;
  const result = spawnSync(
    "sqlite3",
    ["-readonly", "-cmd", ".timeout 5000", "-json", target, sql],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.error || result.status !== 0) {
    NodeFS.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(
      join(stateRoot, "database-check-error.json"),
      JSON.stringify({ code: result.error?.code, status: result.status, stderr: result.stderr }),
      { mode: 0o600 },
    );
    // Classify stderr without exposing database contents or credential-bearing paths.
    const detail = result.stderr ?? "";
    const reason = /locked|busy/i.test(detail)
      ? "database busy"
      : /unable to open/i.test(detail)
        ? "database unavailable"
        : /no such table/i.test(detail)
          ? "required table missing"
          : /readonly/i.test(detail)
            ? "read-only recovery failed"
            : (result.error?.code ?? "query failed");
    throw Error(`Release database check failed: ${reason}; app must remain unchanged`);
  }
  if (stopped) {
    assertNoWal();
    const after = NodeFS.statSync(database);
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw Error("Stopped database changed during verification");
    }
  }
  return JSON.parse(result.stdout || "[]");
}

// T3 thread IDs, e.g. a UUID or `mcp:<uuid>`. The pattern also keeps the id out of SQL syntax.
const threadIdPattern = /^[A-Za-z0-9][A-Za-z0-9:%._-]{0,255}$/;

export function workloadCounts(home, restartThread = null, stopped = false) {
  if (restartThread && !threadIdPattern.test(restartThread)) {
    throw Error("Restart thread must be the calling T3 thread ID");
  }
  const sql = restartThread
    ? workloadSql.replace(
        " GROUP BY",
        ` WHERE NOT (thread_id='${restartThread}' AND status='running') GROUP BY`,
      )
    : workloadSql;
  return classifyWorkload(readReleaseDatabase(home, sql, stopped));
}

/**
 * Who may be interrupted by an activation. By default all work blocks except the
 * caller's own running turn (`restartThread`). `approvedInterrupt` records a
 * human's explicit approval to restart over active work; nothing waits for idle.
 */
export function releasePolicy(options = {}) {
  const restartThread = options.restartThread ?? process.env.T3_FORK_RELEASE_RESTART_THREAD ?? null;
  const approvedInterrupt = options.approvedInterrupt?.trim() || null;
  if (restartThread && !threadIdPattern.test(restartThread)) {
    throw Error("Restart thread must be the calling T3 thread ID");
  }
  return { restartThread, approvedInterrupt };
}

/** Throws while blocking work remains under `policy`; returns the observed counts. */
export function assertReleaseIdle(home, policy, stopped = false) {
  const counts = workloadCounts(home, policy.restartThread, stopped);
  if (!policy.approvedInterrupt) assertIdle(counts);
  return counts;
}

export async function checkDeploy(version, policy = releasePolicy()) {
  assertCutoverTime();
  const home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
  const folder = jobPath(version);
  const release = validateRequest(await readJson(join(folder, "request.json")));
  const value = await readJson(join(folder, "manifest.json"));
  validateManifest(value);
  if (value.commit !== release.commit || value.version !== version) {
    throw new Error("Manifest does not match release request");
  }
  await verifyArtifacts(value);
  assertReleaseIdle(home, policy);
  return { version, commit: value.commit, checks: "artifacts-and-idle-passed", installed: false };
}

async function queue() {
  let versions;
  try {
    versions = await fs.readdir(join(stateRoot, "releases"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const requests = [];
  for (const version of versions) {
    const folder = jobPath(version);
    try {
      requests.push(validateRequest(await readJson(join(folder, "request.json"))));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return requests.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

async function macPull(host, remoteRepo) {
  if (
    process.platform !== "darwin" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(host ?? "") ||
    !remoteRepo?.startsWith("/")
  )
    throw new Error("mac-pull requires a Mac, SSH alias, and absolute remote checkout");
  const remote = `node ${shellQuote(join(remoteRepo, "scripts/fork-release/release.mjs"))} queue`;
  const requests = JSON.parse(
    run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, remote]),
  );
  const results = [];
  for (const item of requests) {
    validateRequest(item);
    await request(item.commit, item.version);
    results.push(await build(item.version));
  }
  return results;
}

async function main() {
  const [command, a, b] = process.argv.slice(2);
  let result;
  if (command === "request") result = await request(a, b);
  else if (command === "build") result = await build(a);
  else if (command === "manifest") result = await manifest(a, b === "--linux-only");
  else if (command === "check-deploy") result = await checkDeploy(a);
  else if (command === "queue") result = await queue();
  else if (command === "mac-pull") result = await macPull(a, b);
  else if (command === "exchange") {
    const { exchange } = await import("./transport.mjs");
    result = await exchange(a, b, process.argv[5]);
  } else if (command === "receipt") {
    if (!["linux-x64", "darwin-arm64"].includes(b)) throw Error("Invalid platform");
    result = await readJson(join(jobPath(a), `${b}.json`));
  } else if (command === "location") result = { path: jobPath(a) };
  else if (command === "installed") {
    const { installedVersion } = await import("./activate.mjs");
    const version = await installedVersion();
    let receipt = null;
    try {
      receipt = await readJson(
        join(jobPath(version), `${process.platform}-${process.arch}-installed.json`),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    result = { version, commit: receipt?.commit ?? null };
  } else if (command === "import") {
    const { importArtifact } = await import("./transport.mjs");
    result = await importArtifact(a, b);
  } else
    throw new Error(
      "Usage: release.mjs request COMMIT VERSION | build VERSION | manifest VERSION [--linux-only] | check-deploy VERSION | queue | mac-pull SSH_ALIAS REMOTE_REPO",
    );
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
