/* oxlint-disable t3code/no-global-process-runtime -- standalone host transport */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
const { spawn } = NodeChildProcess;
const fs = NodeFSP;
const { basename, join } = NodePath;
const { randomUUID } = NodeCrypto;
import {
  atomicJson,
  digest,
  jobPath,
  readJson,
  run,
  shellQuote,
  validateRequest,
  manifest,
} from "./release.mjs";

/** Async child execution keeps the loopback artifact server responsive during installation. */
export function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", ...options });
    child.once("error", () => reject(Error(`${command} could not start`)));
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(`${command} exited ${code}; see private log`)),
    );
  });
}

export function remoteCommand(repo, command, ...args) {
  if (!repo?.startsWith("/") || repo.includes("\n")) throw Error("Absolute checkout required");
  return ["node", join(repo, "scripts/fork-release/release.mjs"), command, ...args]
    .map(shellQuote)
    .join(" ");
}

export function sshArgs(host, command) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(host ?? "")) throw Error("Use an existing SSH alias");
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, command];
}

export async function verifyReceipt(receipt, request) {
  validateRequest(request);
  if (
    !["linux-x64", "darwin-arm64"].includes(receipt.platform) ||
    receipt.commit !== request.commit ||
    receipt.version !== request.version ||
    !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? "") ||
    !Number.isSafeInteger(receipt.bytes) ||
    receipt.bytes <= 0
  ) {
    throw Error("Artifact receipt does not match the request");
  }
  const info = await fs.stat(receipt.path);
  if (
    !info.isFile() ||
    info.size !== receipt.bytes ||
    (await digest(receipt.path)) !== receipt.sha256
  ) {
    throw Error("Artifact bytes do not match receipt");
  }
}

export async function importArtifact(version, receiptPath) {
  const folder = jobPath(version);
  // Only accept files already staged within this exact private release folder.
  if (!receiptPath.startsWith(folder + "/")) throw Error("Receipt outside release folder");
  const receipt = await readJson(receiptPath);
  if (!receipt.path?.startsWith(folder + "/")) throw Error("Artifact outside release folder");
  await verifyReceipt(receipt, await readJson(join(folder, "request.json")));
  const destination = join(folder, `${receipt.platform}.json`);
  try {
    const old = await readJson(destination);
    if (old.sha256 !== receipt.sha256) throw Error("Refusing to replace different artifact");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicJson(destination, receipt);
  return receipt;
}

/** One authenticated outbound SSH channel; transfer to unique files, then verify before adoption. */
export async function exchange(version, host, repo) {
  if (process.platform !== "darwin") throw Error("Exchange runs on the Mac");
  const folder = jobPath(version);
  const request = await readJson(join(folder, "request.json"));
  const readRemote = (command, ...args) =>
    JSON.parse(run("ssh", sshArgs(host, remoteCommand(repo, command, ...args))));
  const linux = readRemote("receipt", version, "linux-x64");
  const remoteFolder = readRemote("location", version).path;
  if (!remoteFolder.startsWith("/") || remoteFolder.includes("\n"))
    throw Error("Invalid remote state");
  const suffix = randomUUID();
  const localLinux = { ...linux, path: join(folder, `${suffix}-${basename(linux.path)}`) };
  const output = await fs.open(localLinux.path, "wx", 0o600);
  try {
    await execute("ssh", sshArgs(host, `cat -- ${shellQuote(linux.path)}`), {
      stdio: ["ignore", output.fd, "ignore"],
    });
  } finally {
    await output.close();
  }
  await verifyReceipt(localLinux, request);
  await atomicJson(join(folder, "linux-x64.json"), localLinux);
  const mac = await readJson(join(folder, "darwin-arm64.json"));
  await verifyReceipt(mac, request);
  const remoteMac = { ...mac, path: join(remoteFolder, `${suffix}-${basename(mac.path)}`) };
  const input = await fs.open(mac.path, "r");
  try {
    await execute("ssh", sshArgs(host, `umask 077; set -C; cat > ${shellQuote(remoteMac.path)}`), {
      stdio: [input.fd, "ignore", "ignore"],
    });
  } finally {
    await input.close();
  }
  const localReceipt = join(folder, `${suffix}-transfer.json`);
  await atomicJson(localReceipt, remoteMac);
  const receiptInput = await fs.open(localReceipt, "r");
  const remoteReceipt = join(remoteFolder, `${suffix}-transfer.json`);
  try {
    await execute("ssh", sshArgs(host, `umask 077; set -C; cat > ${shellQuote(remoteReceipt)}`), {
      stdio: [receiptInput.fd, "ignore", "ignore"],
    });
  } finally {
    await receiptInput.close();
  }
  readRemote("import", version, remoteReceipt);
  readRemote("manifest", version);
  return manifest(version);
}
