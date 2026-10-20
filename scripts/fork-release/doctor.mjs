#!/usr/bin/env node
/* oxlint-disable t3code/no-global-process-runtime -- standalone read-only doctor */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Never return raw remote URLs: they may contain embedded credentials.
export function canonicalRemote(value) {
  if (typeof value !== "string") return null;
  const match = value
    .trim()
    .match(
      /^(?:https:\/\/github\.com\/|git@github\.com:)(affil-ai\/t3code|pingdotgg\/t3code)(?:\.git)?$/,
    );
  return match ? `github.com/${match[1]}` : null;
}

function gitRead(args, cwd) {
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

async function presence(path) {
  try {
    await fs.lstat(path);
    return "present";
  } catch (error) {
    return error.code === "ENOENT" ? "absent" : "unavailable";
  }
}

export async function inspectHost({
  repositoryRoot = root,
  stateRoot = process.env.T3_FORK_RELEASE_STATE ?? join(homedir(), ".local/state/t3-fork-release"),
  git = (args) => gitRead(args, repositoryRoot),
} = {}) {
  const checks = [];
  const origin = canonicalRemote(git(["remote", "get-url", "origin"]));
  const upstream = canonicalRemote(git(["remote", "get-url", "upstream"]));
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain"]);
  checks.push({
    name: "origin",
    status: origin === "github.com/affil-ai/t3code" ? "pass" : "blocked",
  });
  checks.push({
    name: "upstream",
    status: upstream === "github.com/pingdotgg/t3code" ? "pass" : "blocked",
  });
  checks.push({
    name: "git-state",
    status: /^[a-f0-9]{40}$/.test(commit ?? "") && dirty !== null ? "pass" : "unknown",
  });
  let releases = [];
  try {
    releases = (await fs.readdir(join(stateRoot, "releases"), { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && /^\d+\.\d+\.\d+(?:-[\w.-]+)?\.fork\.\d+$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    checks.push({ name: "release-state", status: error.code === "ENOENT" ? "absent" : "unknown" });
  }
  const versions = [];
  for (const version of releases) {
    const folder = join(stateRoot, "releases", version);
    let source = null;
    try {
      const request = JSON.parse(await fs.readFile(join(folder, "request.json"), "utf8"));
      if (
        request.schema !== 1 ||
        request.repository !== "affil-ai/t3code" ||
        request.version !== version ||
        !/^[a-f0-9]{40}$/.test(request.commit ?? "")
      )
        throw Error();
      source = request.commit;
    } catch {
      checks.push({ name: `request:${version}`, status: "unknown" });
    }
    const files = {};
    for (const name of [
      "linux-x64.json",
      "darwin-arm64.json",
      "manifest.json",
      "linux-x64-installed.json",
      "darwin-arm64-installed.json",
      "web-published.json",
      "handoff-error.json",
      "linux-x64.lock",
      "darwin-arm64.lock",
      "request.lock",
    ]) {
      files[name] = await presence(join(folder, name));
    }
    versions.push({ version, source, files });
  }
  const worker = {};
  for (const name of ["worker.json", "worker-status.json", "worker.lock", "handoff.lock"]) {
    worker[name] = await presence(join(stateRoot, name));
  }
  let freeBytes = null;
  try {
    const disk = await fs.statfs(repositoryRoot);
    freeBytes = disk.bavail * disk.bsize;
  } catch {
    checks.push({ name: "disk", status: "unknown" });
  }
  return {
    schema: 1,
    readOnly: true,
    activationReady: false,
    coverage: "local inventory only; receipts and locks are presence checks, not verified outcomes",
    git: {
      origin,
      upstream,
      commit: /^[a-f0-9]{40}$/.test(commit ?? "") ? commit : null,
      clean: dirty === null ? null : dirty === "",
    },
    freeBytes,
    checks,
    versions,
    worker,
    notChecked: [
      "live services and loaded code",
      "active work",
      "artifact hashes",
      "schema/protocol/Office compatibility",
      "GitHub Actions setting",
      "Mac worker registration",
      "public browser acceptance",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  inspectHost()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.checks.some((check) => ["unknown", "blocked"].includes(check.status)))
        process.exitCode = 1;
    })
    .catch(() => {
      console.error("Release inventory unavailable; no deployment readiness established.");
      process.exitCode = 1;
    });
}
