#!/usr/bin/env node
// Fork-owned, read-only release checks. Never pushes, installs, or restarts.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CUTOVER_NOT_BEFORE = "2026-10-19T01:00:00-07:00";

export function assertCutoverTime(now = new Date()) {
  if (!Number.isFinite(now.getTime()) || now < new Date(CUTOVER_NOT_BEFORE)) {
    throw new Error(`Cutover is blocked until ${CUTOVER_NOT_BEFORE}`);
  }
}

export function assertIdle(counts) {
  if (!counts || Array.isArray(counts) || typeof counts !== "object") {
    throw new Error("Run counts are unavailable");
  }
  for (const state of ["running", "starting", "queued", "waiting"]) {
    if (!Number.isSafeInteger(counts[state]) || counts[state] < 0) {
      throw new Error(`Missing or invalid ${state} count`);
    }
    if (counts[state] !== 0) throw new Error(`Busy: ${state}=${counts[state]}`);
  }
}

export function assertFreshMigration(manifest, sourceHead) {
  if (manifest.phase !== "prepared") {
    throw new Error("Migration already started; reconcile canonical Affil state");
  }
  if (!/^[a-f0-9]{40}$/.test(sourceHead) || manifest.sourceCommit !== sourceHead) {
    throw new Error("Source moved; refresh the migration commit and rebuild");
  }
}

export function validateManifest(manifest) {
  if (manifest.schema !== 1 || manifest.repository !== "affil-ai/t3code") {
    throw new Error("Unexpected release schema or repository");
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.commit ?? "")) {
    throw new Error("Release requires a full canonical source commit");
  }
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\.fork\.\d+$/.test(manifest.version ?? "")) {
    throw new Error("Release requires a unique fork version");
  }
  const linuxOnly = manifest.scope === "linux-only";
  if (manifest.scope !== undefined && !linuxOnly) throw new Error("Unknown release scope");
  if (
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== (linuxOnly ? 1 : 2) ||
    (linuxOnly && manifest.artifacts[0]?.platform !== "linux-x64")
  ) {
    throw new Error(
      linuxOnly
        ? "A Linux-only release has exactly one Linux artifact"
        : "Require exactly one Linux and one Mac artifact",
    );
  }
  const platforms = new Set();
  for (const artifact of manifest.artifacts) {
    if (
      !["linux-x64", "darwin-arm64"].includes(artifact.platform) ||
      platforms.has(artifact.platform)
    ) {
      throw new Error("Invalid or duplicate artifact platform");
    }
    platforms.add(artifact.platform);
    if (artifact.commit !== manifest.commit || artifact.version !== manifest.version) {
      throw new Error("Artifact commit/version mismatch");
    }
    if (
      !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") ||
      typeof artifact.path !== "string" ||
      !artifact.path ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0
    ) {
      throw new Error("Artifact requires path, byte size, and SHA-256");
    }
  }
}

export async function verifyArtifacts(manifest) {
  validateManifest(manifest);
  for (const artifact of manifest.artifacts) {
    const info = await stat(artifact.path);
    if (!info.isFile() || info.size !== artifact.bytes) {
      throw new Error(`Artifact size mismatch: ${artifact.platform}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(artifact.path)) hash.update(chunk);
    if (hash.digest("hex") !== artifact.sha256) {
      throw new Error(`Artifact checksum mismatch: ${artifact.platform}`);
    }
  }
}

function github(args) {
  try {
    return JSON.parse(
      execFileSync("gh", ["api", ...args], {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    // Provider diagnostics can contain private request information.
    throw new Error("GitHub preflight failed; inspect authentication privately");
  }
}

export function preflight() {
  const source = github(["repos/volumbe/t3code/git/ref/heads/main"]);
  const destination = github(["repos/affil-ai/t3code"]);
  const target = github(["repos/affil-ai/t3code/git/ref/heads/main"]);
  const actions = github(["repos/affil-ai/t3code/actions/permissions"]);
  return {
    observedAt: new Date().toISOString(),
    sourceCommit: source.object.sha,
    destinationCommit: target.object.sha,
    destinationDefaultBranch: destination.default_branch,
    githubActionsEnabled: actions.enabled,
    cutoverNotBefore: CUTOVER_NOT_BEFORE,
    readOnly: true,
  };
}

async function main() {
  const [command, file] = process.argv.slice(2);
  if (command === "preflight") {
    console.log(JSON.stringify(preflight(), null, 2));
  } else if (command === "verify-artifacts" && file) {
    const manifest = JSON.parse(await readFile(resolve(file), "utf8"));
    await verifyArtifacts(manifest);
    console.log("Both artifact hashes match. This is not deployment approval.");
  } else if (command === "cutover-time") {
    assertCutoverTime();
    console.log(
      "Time gate passed. Fresh source, idle, and compatibility checks are still required.",
    );
  } else {
    throw new Error(
      "Usage: release-check.mjs preflight | verify-artifacts MANIFEST | cutover-time",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
