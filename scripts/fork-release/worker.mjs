#!/usr/bin/env node
/* oxlint-disable t3code/no-global-process-runtime -- detached host-side release worker */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import {
  atomicJson,
  jobPath,
  readJson,
  run,
  shellQuote,
  sourceRoot,
  stateRoot,
  withLock,
} from "./release.mjs";
import { assertForwardVersion, installedVersion, qualify } from "./activate.mjs";
import { exchange, execute, remoteCommand, sshArgs } from "./transport.mjs";
import { watch, xml } from "./handoff.mjs";

const { join, resolve } = NodePath;
const { pathToFileURL } = NodeURL;
const fs = NodeFSP;
const configPath = join(stateRoot, "worker.json");

export function baselineFor(current, bootstrap) {
  if (current.commit && /^[a-f0-9]{40}$/.test(current.commit)) return current.commit;
  if (current.version === bootstrap.version && /^[a-f0-9]{40}$/.test(bootstrap.commit))
    return bootstrap.commit;
  throw Error("Installed source is unknown; review this host before releasing");
}

export function nextRequest(requests, currentVersion, minimumVersion) {
  return requests
    .filter((request) => {
      try {
        assertForwardVersion(currentVersion, request.version);
        assertForwardVersion(minimumVersion, request.version);
      } catch {
        return false;
      }
      return request.version !== currentVersion;
    })
    .sort((a, b) => Number(a.version.split(".fork.")[1]) - Number(b.version.split(".fork.")[1]))[0];
}

async function work() {
  const config = await readJson(configPath);
  return withLock(join(stateRoot, "worker.lock"), async () => {
    const remote = (command, ...args) =>
      JSON.parse(run("ssh", sshArgs(config.host, remoteCommand(config.repo, command, ...args))));
    while (true) {
      let requests;
      try {
        requests = remote("queue");
      } catch {
        await atomicJson(join(stateRoot, "worker-status.json"), {
          phase: "offline",
          at: new Date().toISOString(),
        });
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        continue;
      }
      const currentVersion = await installedVersion();
      const request = nextRequest(requests, currentVersion, config.minimumVersion);
      if (!request) {
        await atomicJson(join(stateRoot, "worker-status.json"), {
          phase: "idle",
          version: currentVersion,
          at: new Date().toISOString(),
        });
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        continue;
      }
      // Ubuntu builds first. Missing receipt means no work for the Mac yet.
      try {
        remote("receipt", request.version, "linux-x64");
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        continue;
      }
      const folder = jobPath(request.version);
      const log = await fs.open(join(stateRoot, "worker-build.log"), "a", 0o600);
      try {
        const cli = join(sourceRoot, "scripts/fork-release/release.mjs");
        for (const args of [
          ["request", request.commit, request.version],
          ["build", request.version],
        ]) {
          await execute(process.execPath, [cli, ...args], { stdio: ["ignore", log.fd, log.fd] });
        }
        await exchange(request.version, config.host, config.repo);
        const local = JSON.parse(run(process.execPath, [cli, "installed"]));
        const linux = remote("installed");
        await qualify(request.version, baselineFor(local, config.mac), config.mac.sharedDiff);
        const remoteArgs = [
          "node",
          join(config.repo, "scripts/fork-release/activate.mjs"),
          "qualify",
          request.version,
          baselineFor(linux, config.linux),
        ];
        if (config.linux.sharedDiff) remoteArgs.push(config.linux.sharedDiff);
        await execute("ssh", sshArgs(config.host, remoteArgs.map(shellQuote).join(" ")), {
          stdio: ["ignore", log.fd, log.fd],
        });
        await atomicJson(join(stateRoot, "worker-status.json"), {
          phase: "handoff",
          version: request.version,
          at: new Date().toISOString(),
        });
        await watch(request.version, config.host, config.repo);
        const status = await readJson(join(folder, "handoff.json"));
        if (status.phase !== "installed")
          throw Error("Idle deadline passed; inspect handoff before retry");
      } finally {
        await log.close();
      }
    }
  });
}

/** Install only when no earlier release job is registered. Never replace a running installer. */
async function install(configFile) {
  if (process.platform !== "darwin") throw Error("The pull worker runs on Mac");
  const config = await readJson(resolve(configFile));
  sshArgs(config.host, "");
  remoteCommand(config.repo, "queue");
  assertForwardVersion(config.mac.version, config.minimumVersion);
  baselineFor({ version: config.mac.version, commit: null }, config.mac);
  baselineFor({ version: config.linux.version, commit: null }, config.linux);
  const label = "com.affil.t3-fork-release";
  try {
    run("launchctl", ["print", `gui/${process.getuid()}/${label}`]);
    throw Error("Release job already registered; inspect it first");
  } catch (error) {
    if (error.message.startsWith("Release job")) throw error;
  }
  await atomicJson(configPath, config);
  const agents = join(NodeOS.homedir(), "Library/LaunchAgents");
  await fs.mkdir(agents, { recursive: true });
  const plist = join(agents, `${label}.plist`);
  const args = [process.execPath, join(sourceRoot, "scripts/fork-release/worker.mjs"), "run"];
  await fs.writeFile(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(NodeOS.homedir())}</string>
<key>PATH</key><string>${xml(process.env.PATH)}</string></dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(join(stateRoot, "worker.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(stateRoot, "worker.log"))}</string>
</dict></plist>`,
    { mode: 0o600 },
  );
  run("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist]);
  return { phase: "worker-started", configPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, path] = process.argv.slice(2);
  (command === "install"
    ? install(path)
    : command === "run"
      ? work()
      : Promise.reject(Error("Usage: worker.mjs install CONFIG_JSON | run"))
  )
    .then((result) => {
      if (result) console.log(JSON.stringify(result));
    })
    .catch(async (error) => {
      await atomicJson(join(stateRoot, "worker-status.json"), {
        phase: "needs-review",
        detail: error.message,
        at: new Date().toISOString(),
      });
      console.error(error.message);
      process.exitCode = 1;
    });
}
