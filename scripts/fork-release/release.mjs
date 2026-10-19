#!/usr/bin/env node
// Preparation only: builds never activate a server or quit the desktop app.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = "https://github.com/affil-ai/t3code.git";
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stateRoot = resolve(
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

export async function withLock(path, operation) {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("Release is locked; inspect its owner before retrying");
    throw error;
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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: sourceRoot,
    encoding: "utf8",
    timeout: 30_000,
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

async function readJson(path) {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest("hex");
}

function jobPath(version) {
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

async function build(version) {
  const job = jobPath(version);
  const value = validateRequest(await readJson(join(job, "request.json")));
  const platform = `${process.platform}-${process.arch}`;
  if (!["linux-x64", "darwin-arm64"].includes(platform)) throw new Error("Unsupported build host");
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
      execute(
        process.execPath,
        ["scripts/update-release-package-versions.ts", version],
        checkout,
        env,
      );
      let artifact;
      if (platform === "linux-x64") {
        const [major, minor] = process.versions.node.split(".").map(Number);
        if (major < 25 || (major === 25 && minor < 7))
          throw new Error("Linux executable build needs Node 25.7+");
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
        execute(process.execPath, ["apps/server/scripts/cli.ts", "build-exe"], checkout, env);
        execute(
          process.execPath,
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
          process.execPath,
          ["scripts/smoke-cli-archive.ts", "--archive", artifact, "--expect-version", version],
          checkout,
          env,
        );
      } else {
        execute(
          process.execPath,
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
    !/^[a-zA-Z0-9_-]+$/.test(host ?? "") ||
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
  else if (command === "queue") result = await queue();
  else if (command === "mac-pull") result = await macPull(a, b);
  else
    throw new Error(
      "Usage: release.mjs request COMMIT VERSION | build VERSION | queue | mac-pull SSH_ALIAS REMOTE_REPO",
    );
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
