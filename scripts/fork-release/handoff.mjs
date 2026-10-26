#!/usr/bin/env node
// One detached, bounded installer for one release. No timer, recurring schedule, or inbound listener.
/* oxlint-disable t3code/no-global-process-runtime -- standalone launchd host installer */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
const { spawnSync } = NodeChildProcess;
const fs = NodeFSP;
const { join, resolve } = NodePath;
const { pathToFileURL } = NodeURL;
const { homedir } = NodeOS;
import {
  assertReleaseIdle,
  atomicJson,
  jobPath,
  readJson,
  releasePolicy,
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

// Ubuntu activation from anywhere, including an agent running inside T3. The
// restart stops every T3 provider process tree, so the install runs in its own
// transient user unit and the caller reads the result after it resumes.
export async function watchLinux(version, options = {}) {
  if (process.platform !== "linux") throw Error("Ubuntu handoff must run on Linux");
  const folder = jobPath(version);
  const request = validateRequest(await readJson(join(folder, "request.json")));
  const policy = releasePolicy(options);
  const checkpoint = (phase, detail = {}) =>
    atomicJson(join(folder, "handoff-linux.json"), {
      ...request,
      phase,
      unit: linuxUnit,
      policy,
      ...detail,
      at: new Date().toISOString(),
    });
  return withLock(join(stateRoot, "handoff.lock"), async () => {
    await verifyArtifacts(await readJson(join(folder, "manifest.json")));
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      let counts;
      try {
        counts = assertReleaseIdle(process.env.T3CODE_HOME ?? join(homedir(), ".t3"), policy);
      } catch (error) {
        await checkpoint("waiting", { detail: error.message });
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        continue;
      }
      await checkpoint("activating", { counts });
      try {
        // Rechecks provenance, schema, and Office; rolls back if the target is unhealthy.
        const installed = await activate(version, policy);
        await checkpoint("ubuntu-and-web-origin-installed", {
          installed,
          browserVerification: "pending",
        });
        return installed;
      } catch (error) {
        const activation = await readJson(join(folder, "linux-x64-activation.json")).catch(
          () => null,
        );
        await checkpoint(activation?.phase === "rolled-back" ? "rolled-back" : "failed", {
          error: error.message,
          activation,
        });
        throw error;
      }
    }
    await checkpoint("pending", {
      detail: "Idle window not reached within 24 hours; safe to retry",
    });
    throw Error("Ubuntu remained busy for 24 hours; no work was cancelled");
  });
}

const linuxUnit = "t3-fork-release.service";

/** `start-linux` options: `--restart-thread ID` and `--approved-interrupt NOTE`. */
export function parseLinuxOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (!value) throw Error(`${flag} needs a value`);
    if (flag === "--restart-thread") options.restartThread = value;
    else if (flag === "--approved-interrupt") options.approvedInterrupt = value;
    else throw Error(`Unknown option ${flag}`);
  }
  return options;
}

export function linuxUnitArgs(version, policy, log, env = process.env) {
  const setenv = {
    PATH: env.PATH,
    T3CODE_HOME: env.T3CODE_HOME ?? join(homedir(), ".t3"),
    T3_FORK_RELEASE_STATE: env.T3_FORK_RELEASE_STATE,
  };
  return [
    "--user",
    `--unit=${linuxUnit}`,
    "--collect",
    "--property=Type=exec",
    "--property=UMask=0077",
    `--property=StandardOutput=append:${log}`,
    `--property=StandardError=append:${log}`,
    ...Object.entries(setenv)
      .filter(([, value]) => value)
      .map(([name, value]) => `--setenv=${name}=${value}`),
    process.execPath,
    join(sourceRoot, "scripts/fork-release/handoff.mjs"),
    "watch-linux",
    version,
    ...(policy.restartThread ? ["--restart-thread", policy.restartThread] : []),
    ...(policy.approvedInterrupt ? ["--approved-interrupt", policy.approvedInterrupt] : []),
  ];
}

export async function startLinux(version, options = {}) {
  if (process.platform !== "linux") throw Error("Start Ubuntu handoff on Linux");
  const folder = jobPath(version);
  const request = validateRequest(await readJson(join(folder, "request.json")));
  const policy = releasePolicy(options);
  // Fail here, where the caller sees it, rather than inside the detached unit.
  const unitState = spawnSync("systemctl", ["--user", "is-active", linuxUnit], {
    encoding: "utf8",
  }).stdout?.trim();
  if (["active", "activating", "reloading"].includes(unitState))
    throw Error(`${linuxUnit} is already running; read handoff-linux.json instead of retrying`);
  await readJson(join(folder, "manifest.json"));
  await readJson(join(folder, "linux-x64-qualification.json"));
  const status = join(folder, "handoff-linux.json");
  const error = join(folder, "handoff-error.json");
  const log = join(folder, "handoff-linux.log");
  // A resumed agent must not mistake an earlier attempt's result for this one.
  await fs.rm(error, { force: true });
  await atomicJson(status, {
    ...request,
    phase: "starting",
    unit: linuxUnit,
    policy,
    at: new Date().toISOString(),
  });
  // A fixed unit name prevents duplicate detached installers. No timer or recurring schedule.
  run("systemd-run", linuxUnitArgs(version, policy, log));
  return {
    version,
    phase: "started",
    unit: linuxUnit,
    status,
    error,
    log,
    next: "The server restart ends this agent's turn. After resuming, read the status file.",
  };
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
  const linuxOptions = () => parseLinuxOptions(process.argv.slice(4));
  (command === "start-linux"
    ? Promise.resolve().then(() => startLinux(version, linuxOptions()))
    : command === "watch-linux"
      ? Promise.resolve().then(() => watchLinux(version, linuxOptions()))
      : command === "start"
        ? handoff(version, host, repo)
        : command === "start-mac"
          ? handoff(version, host, repo, true)
          : command === "watch-mac"
            ? watch(version, host, repo, true)
            : command === "watch"
              ? watch(version, host, repo)
              : Promise.reject(
                  Error(
                    "Usage: handoff.mjs start VERSION SSH_ALIAS REMOTE_CHECKOUT | start-linux VERSION [--restart-thread ID] [--approved-interrupt NOTE]",
                  ),
                )
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
