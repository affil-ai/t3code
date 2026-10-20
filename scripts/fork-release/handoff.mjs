#!/usr/bin/env node
// One detached, bounded installer for one release. No timer, recurring schedule, or inbound listener.
/* oxlint-disable t3code/no-global-process-runtime -- standalone launchd host installer */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
const fs = NodeFSP;
const { join, resolve } = NodePath;
const { pathToFileURL } = NodeURL;
const { homedir } = NodeOS;
import {
  atomicJson,
  jobPath,
  readJson,
  run,
  shellQuote,
  sourceRoot,
  stateRoot,
  validateRequest,
  withLock,
  workloadCounts,
} from "./release.mjs";
import { assertIdle, verifyArtifacts } from "./release-check.mjs";
import { activate, releaseGuard } from "./activate.mjs";
import { execute, sshArgs } from "./transport.mjs";

export function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Recover a Mac-only release without reinstalling the Mac or interrupting Ubuntu turns.
export async function watchLinux(version) {
  if (process.platform !== "linux") throw Error("Ubuntu handoff must run on Linux");
  const folder = jobPath(version);
  const request = validateRequest(await readJson(join(folder, "request.json")));
  return withLock(join(stateRoot, "handoff.lock"), async () => {
    await verifyArtifacts(await readJson(join(folder, "manifest.json")));
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      const counts = workloadCounts(join(homedir(), ".t3"));
      try {
        assertIdle(counts);
      } catch {
        await atomicJson(join(folder, "handoff-linux.json"), {
          ...request,
          phase: "waiting",
          counts,
          at: new Date().toISOString(),
        });
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        continue;
      }
      await activate(version); // Rechecks idle, provenance, schema, and Office, then publishes web.
      await atomicJson(join(folder, "handoff-linux.json"), {
        ...request,
        phase: "ubuntu-and-web-origin-installed",
        browserVerification: "pending",
        at: new Date().toISOString(),
      });
      return;
    }
    throw Error("Ubuntu remained busy for 24 hours; no work was cancelled");
  });
}

export async function startLinux(version) {
  if (process.platform !== "linux") throw Error("Start Ubuntu handoff on Linux");
  validateRequest(await readJson(join(jobPath(version), "request.json")));
  // A fixed unit name prevents duplicate detached installers. No timer or recurring schedule.
  run("systemd-run", [
    "--user",
    "--unit=t3-fork-release",
    "--collect",
    "--property=Type=exec",
    "--property=UMask=0077",
    process.execPath,
    join(sourceRoot, "scripts/fork-release/handoff.mjs"),
    "watch-linux",
    version,
  ]);
  return { version, phase: "waiting-for-idle", unit: "t3-fork-release.service" };
}

export async function watch(version, host, repo, macOnly = false) {
  const folder = jobPath(version);
  const request = validateRequest(await readJson(join(folder, "request.json")));
  return withLock(join(stateRoot, "handoff.lock"), async () => {
    const checkpoint = (phase, detail = "") =>
      atomicJson(join(folder, "handoff.json"), {
        ...request,
        phase,
        detail,
        at: new Date().toISOString(),
      });
    const remote = (command) => run("ssh", sshArgs(host, command));
    await verifyArtifacts(await readJson(join(folder, "manifest.json")));
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      try {
        assertIdle(
          workloadCounts(
            join(homedir(), ".t3"),
            macOnly ? process.env.T3_FORK_RELEASE_RESTART_THREAD : null,
          ),
        );
        if (!macOnly) {
          remote(
            ["node", join(repo, "scripts/fork-release/release.mjs"), "check-deploy", version]
              .map(shellQuote)
              .join(" "),
          );
        }
      } catch {
        await checkpoint("waiting", "Host busy or unreachable; no installation attempted");
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        continue;
      }
      // Both qualifications and hashes must pass before either host is activated.
      await releaseGuard(version);
      if (macOnly) {
        await checkpoint("activating-mac");
        await activate(version);
        await checkpoint("mac-installed", "Mac API verified; Ubuntu was not restarted");
        return;
      }
      remote(
        ["node", join(repo, "scripts/fork-release/activate.mjs"), "check", version]
          .map(shellQuote)
          .join(" "),
      );
      await checkpoint("activating-linux");
      const log = await fs.open(join(folder, "handoff-linux.log"), "a", 0o600);
      try {
        await execute(
          "ssh",
          sshArgs(
            host,
            ["node", join(repo, "scripts/fork-release/activate.mjs"), "install", version]
              .map(shellQuote)
              .join(" "),
          ),
          { stdio: ["ignore", log.fd, log.fd] },
        );
      } finally {
        await log.close();
      }
      // The Mac can become busy while Linux installs. Wait; never interrupt its new work.
      while (Date.now() < deadline) {
        try {
          assertIdle(workloadCounts(join(homedir(), ".t3")));
          break;
        } catch {
          await checkpoint("waiting-mac");
          await new Promise((resolve) => setTimeout(resolve, 30_000));
        }
      }
      if (Date.now() >= deadline)
        throw Error("Mac stayed busy; Linux installed, Mac remains pending");
      await checkpoint("activating-mac");
      await activate(version);
      await checkpoint(
        "installed",
        "Both APIs report target version; UI acceptance remains required",
      );
      return;
    }
    await checkpoint("pending", "Idle window not reached within 24 hours; safe to retry");
  });
}

export async function handoff(version, host, repo, macOnly = false) {
  if (process.platform !== "darwin") throw Error("Launch the pull-side handoff on Mac");
  sshArgs(host, "");
  if (!repo?.startsWith("/") || repo.includes("\n"))
    throw Error("Absolute Ubuntu checkout required");
  const folder = jobPath(version);
  validateRequest(await readJson(join(folder, "request.json")));
  const restartThread = macOnly ? process.env.T3_FORK_RELEASE_RESTART_THREAD : null;
  if (restartThread) {
    // Explicit opt-in for the invoking Mac chat only. All other work still blocks.
    assertIdle(workloadCounts(join(homedir(), ".t3"), restartThread));
  }
  const label = "com.affil.t3-fork-release";
  // Never replace an existing installer. A completed launchd job can be removed explicitly.
  try {
    run("launchctl", ["print", `gui/${process.getuid()}/${label}`]);
    throw Error("Handoff already registered; inspect it before retrying");
  } catch (error) {
    if (error.message.startsWith("Handoff already")) throw error;
  }
  const plist = join(folder, "handoff.plist");
  const args = [
    process.execPath,
    join(sourceRoot, "scripts/fork-release/handoff.mjs"),
    macOnly ? "watch-mac" : "watch",
    version,
    host,
    repo,
  ];
  await fs.writeFile(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(homedir())}</string>
<key>PATH</key><string>${xml(process.env.PATH)}</string>
${restartThread ? `<key>T3_FORK_RELEASE_RESTART_THREAD</key><string>${xml(restartThread)}</string>` : ""}
</dict>
<key>StandardOutPath</key><string>${xml(join(folder, "handoff.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(folder, "handoff.log"))}</string>
<key>RunAtLoad</key><true/>
</dict></plist>`,
    { mode: 0o600 },
  );
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist]);
  return { version, phase: "waiting-for-idle", checkpoint: join(folder, "handoff.json") };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, version, host, repo] = process.argv.slice(2);
  (command === "start-linux"
    ? startLinux(version)
    : command === "watch-linux"
      ? watchLinux(version)
      : command === "start"
        ? handoff(version, host, repo)
        : command === "start-mac"
          ? handoff(version, host, repo, true)
          : command === "watch-mac"
            ? watch(version, host, repo, true)
            : command === "watch"
              ? watch(version, host, repo)
              : Promise.reject(Error("Usage: handoff.mjs start VERSION SSH_ALIAS REMOTE_CHECKOUT"))
  )
    .then((value) => {
      if (value) console.log(JSON.stringify(value));
    })
    .catch(async (error) => {
      if (version)
        await atomicJson(join(jobPath(version), "handoff-error.json"), {
          message: error.message,
          at: new Date().toISOString(),
        });
      console.error(error.message);
      process.exitCode = 1;
    });
}
