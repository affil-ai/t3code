import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalRemote, inspectHost } from "./doctor.mjs";

test("remote classification never returns credentials or arbitrary addresses", () => {
  assert.equal(
    canonicalRemote("https://github.com/affil-ai/t3code.git"),
    "github.com/affil-ai/t3code",
  );
  assert.equal(
    canonicalRemote("git@github.com:pingdotgg/t3code.git"),
    "github.com/pingdotgg/t3code",
  );
  for (const value of [
    "https://user:secret@github.com/affil-ai/t3code",
    "https://private.invalid/repo",
    null,
  ]) {
    assert.equal(canonicalRemote(value), null);
  }
});

test("inventory preserves bytes, reports malformed requests, and never treats receipts as readiness", async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "fork-doctor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const version = "0.1.0-stable.fork.999";
  const release = join(directory, "releases", version);
  await fs.mkdir(release, { recursive: true });
  const request = JSON.stringify({
    schema: 1,
    repository: "affil-ai/t3code",
    version,
    commit: "a".repeat(40),
  });
  await fs.writeFile(join(release, "request.json"), request);
  await fs.writeFile(join(release, "darwin-arm64-installed.json"), "not a verified receipt");
  await fs.mkdir(join(directory, "worker.lock"));
  const git = (args) => {
    if (args.includes("origin")) return "https://github.com/affil-ai/t3code.git";
    if (args.includes("upstream")) return "git@github.com:pingdotgg/t3code.git";
    if (args.includes("HEAD")) return "a".repeat(40);
    return "";
  };
  const report = await inspectHost({ repositoryRoot: directory, stateRoot: directory, git });
  assert.equal(report.git.clean, true);
  assert.equal(report.activationReady, false);
  assert.equal(report.versions[0].source, "a".repeat(40));
  assert.equal(report.versions[0].files["darwin-arm64-installed.json"], "present");
  assert.equal(report.worker["worker.lock"], "present");
  assert.equal(await fs.readFile(join(release, "request.json"), "utf8"), request);
  await fs.writeFile(join(release, "request.json"), "{bad");
  const invalid = await inspectHost({ repositoryRoot: directory, stateRoot: directory, git });
  assert.equal(invalid.versions[0].source, null);
  assert.ok(invalid.checks.some((check) => check.status === "unknown"));
});

test("unavailable Git and absent state remain unknown and do not create state", async (t) => {
  const directory = await fs.mkdtemp(join(tmpdir(), "fork-doctor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stateRoot = join(directory, "absent");
  const report = await inspectHost({ repositoryRoot: directory, stateRoot, git: () => null });
  assert.equal(report.git.clean, null);
  assert.equal(report.git.commit, null);
  assert.equal(report.activationReady, false);
  await assert.rejects(fs.stat(stateRoot), { code: "ENOENT" });
});
