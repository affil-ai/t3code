#!/usr/bin/env node
// Public web is static files behind the existing Access gateway. Never change that gateway.
/* oxlint-disable t3code/no-global-process-runtime -- standalone release command */
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const fs = NodeFSP;
const { createHash, randomUUID } = NodeCrypto;
const { homedir } = NodeOS;
const { join, resolve } = NodePath;
const { pathToFileURL } = NodeURL;
import {
  atomicJson,
  jobPath,
  readJson,
  run,
  sourceRoot,
  validateRequest,
  withLock,
} from "./release.mjs";

export const webRoot = join(homedir(), ".local/share/t3-work-web");
export const publicUrl = "https://t3.olumbe.com";
const metadataFile = "fork-release.json";

export async function inventory(root, prefix = "") {
  const files = {};
  for (const entry of await fs.readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw Error("Web payload contains a symlink");
    if (entry.isDirectory()) Object.assign(files, await inventory(root, name));
    else if (entry.isFile() && name !== metadataFile) {
      if (name.endsWith(".map") || entry.name.startsWith(".")) throw Error("Unsafe web payload");
      files[name] = createHash("sha256")
        .update(await fs.readFile(join(root, name)))
        .digest("hex");
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export async function verifyWeb(folder, request) {
  validateRequest(request);
  const receipt = await readJson(join(folder, metadataFile));
  if (
    receipt.commit !== request.commit ||
    receipt.version !== request.version ||
    receipt.repository !== request.repository ||
    receipt.url !== publicUrl
  ) {
    throw Error("Web source/version mismatch");
  }
  const actual = await inventory(folder);
  if (!actual["index.html"] || JSON.stringify(actual) !== JSON.stringify(receipt.files))
    throw Error("Web asset checksums differ");
  return receipt;
}

export function assertBackend(request, backend) {
  if (backend?.serverVersion !== request.version || backend?.orchestrationProtocolVersion !== 2)
    throw Error(`Public web pending: Ubuntu must run ${request.version} with protocol 2 first`);
}

// Called by Linux build while it still owns its isolated source checkout.
export async function stageWeb(checkout, request, env, log) {
  validateRequest(request);
  return withLock(join(jobPath(request.version), "web-stage.lock"), () =>
    stageWebLocked(checkout, request, env, log),
  );
}

async function stageWebLocked(checkout, request, env, log) {
  validateRequest(request);
  if (run("git", ["rev-parse", "HEAD"], { cwd: checkout }) !== request.commit)
    throw Error("Web checkout does not match request");
  const folder = join(jobPath(request.version), "web");
  try {
    await fs.access(folder);
    return await verifyWeb(folder, request);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const buildEnv = {
    ...env,
    APP_VERSION: request.version,
    T3CODE_WEB_SOURCEMAP: "false",
    VITE_HTTP_URL: "",
    VITE_WS_URL: "",
    VITE_HOSTED_APP_CHANNEL: "",
    VITE_HOSTED_APP_URL: publicUrl,
    PATH: `${checkout}/node_modules/.bin:${env.PATH}`,
  };
  const options = {
    cwd: checkout,
    env: buildEnv,
    timeout: 60 * 60 * 1000,
    stdio: ["ignore", log.fd, log.fd],
  };
  run("vp", ["run", "--filter", "@t3tools/web", "build"], options);
  run(process.execPath, ["scripts/apply-web-brand-assets.ts", "production"], options);
  const staging = await fs.mkdtemp(join(jobPath(request.version), "web-stage-"));
  await fs.cp(join(checkout, "apps/web/dist"), staging, {
    recursive: true,
    filter: (path) => !path.endsWith(".map"),
  });
  const receipt = {
    ...request,
    url: publicUrl,
    files: await inventory(staging),
    builtAt: new Date().toISOString(),
  };
  if (!receipt.files["index.html"]) throw Error("Web build has no entrypoint");
  await atomicJson(join(staging, metadataFile), receipt);
  await fs.rename(staging, folder);
  await atomicJson(join(jobPath(request.version), "web-built.json"), {
    version: request.version,
    commit: request.commit,
    path: folder,
  });
  return receipt;
}

export async function buildWeb(version) {
  const request = validateRequest(await readJson(join(jobPath(version), "request.json")));
  return withLock(join(jobPath(version), "web-build.lock"), async () => {
    const folder = join(jobPath(version), "web");
    try {
      await fs.access(folder);
      return await verifyWeb(folder, request);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const attempt = await fs.mkdtemp(join(jobPath(version), "web-build-"));
    const checkout = join(attempt, "source");
    const log = await fs.open(join(attempt, "build.log"), "wx", 0o600);
    try {
      const options = { cwd: attempt, stdio: ["ignore", log.fd, log.fd], timeout: 3600000 };
      run("git", ["clone", "--no-checkout", "--no-hardlinks", sourceRoot, checkout], options);
      run("git", ["checkout", "--detach", request.commit], { ...options, cwd: checkout });
      const pkg = await readJson(join(checkout, "package.json"));
      if (!/^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager))
        throw Error("Unsupported package manager");
      const env = {
        ...process.env,
        PATH: `${checkout}/node_modules/.bin:${process.env.PATH}`,
        TURBO_CONCURRENCY: "2",
      };
      run("npx", ["--yes", pkg.packageManager, "install", "--frozen-lockfile"], {
        ...options,
        cwd: checkout,
        env,
      });
      return await stageWeb(checkout, request, env, log);
    } finally {
      await log.close();
      // Preserve logs, requests, receipts, and artifacts. Only this isolated checkout is disposable.
      await fs.rm(checkout, { recursive: true, force: true });
    }
  });
}

export async function switchWeb(root, payload, request, observeBackend) {
  return withLock(join(root, "publish.lock"), async () => {
    await verifyWeb(payload, request);
    assertBackend(request, await observeBackend());
    const current = join(root, "current");
    const previous = await fs.realpath(current);
    const releases = await fs.realpath(join(root, "releases"));
    if (!previous.startsWith(`${releases}/`)) throw Error("Unexpected current web target");
    try {
      const existing = await readJson(join(previous, metadataFile));
      if (existing.commit === request.commit && existing.version === request.version) {
        await verifyWeb(previous, request);
        return {
          version: request.version,
          commit: request.commit,
          url: publicUrl,
          current: previous,
          phase: "published-origin",
          unchanged: true,
          verifiedAt: new Date().toISOString(),
          browserVerification: "pending",
        };
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const stage = await fs.mkdtemp(join(releases, `${request.commit}-`));
    await fs.cp(payload, stage, { recursive: true });
    // Preserve lazy-loaded chunks for open clients. Refuse same-name, different-byte collisions.
    const oldFiles = await inventory(previous);
    for (const [name, hash] of Object.entries(oldFiles)) {
      if (!name.startsWith("assets/")) continue;
      const destination = join(stage, name);
      try {
        const bytes = await fs.readFile(destination);
        if (createHash("sha256").update(bytes).digest("hex") !== hash)
          throw Error("Web asset name collision");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await fs.mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
        await fs.copyFile(join(previous, name), destination);
      }
    }
    const stagedReceipt = {
      ...(await readJson(join(stage, metadataFile))),
      files: await inventory(stage),
    };
    await atomicJson(join(stage, metadataFile), stagedReceipt);
    await verifyWeb(stage, request);
    assertBackend(request, await observeBackend());
    if ((await fs.realpath(current)) !== previous)
      throw Error("Web target moved during publication");
    const link = join(root, `current-${randomUUID()}`);
    await fs.symlink(stage, link);
    await fs.rename(link, current);
    await verifyWeb(await fs.realpath(current), request);
    return {
      version: request.version,
      commit: request.commit,
      url: publicUrl,
      previous,
      current: stage,
      phase: "published-origin",
      verifiedAt: new Date().toISOString(),
      browserVerification: "pending",
    };
  });
}

export async function publishWeb(version) {
  if (process.platform !== "linux") throw Error("Publish web on Ubuntu as its work identity");
  const request = validateRequest(await readJson(join(jobPath(version), "request.json")));
  run("git", ["fetch", "--no-tags", "https://github.com/affil-ai/t3code.git", "main"]);
  run("git", ["merge-base", "--is-ancestor", request.commit, "FETCH_HEAD"]);
  run("systemctl", ["--user", "is-active", "t3-work-web.service"]);
  const installed = await readJson(join(jobPath(version), "linux-x64-installed.json"));
  if (installed.commit !== request.commit || installed.version !== version)
    throw Error("Ubuntu installed provenance does not match web request");
  const observe = async () => {
    const response = await fetch("http://127.0.0.1:3779/.well-known/t3/environment", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw Error("Ubuntu discovery unavailable");
    return response.json();
  };
  const result = await switchWeb(webRoot, join(jobPath(version), "web"), request, observe);
  await atomicJson(join(jobPath(version), "web-published.json"), result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, version] = process.argv.slice(2);
  (command === "build"
    ? buildWeb(version)
    : command === "publish"
      ? publishWeb(version)
      : Promise.reject(Error("Usage: web.mjs build VERSION | publish VERSION"))
  )
    .then((result) =>
      console.log(
        JSON.stringify({
          version: result.version,
          commit: result.commit,
          url: result.url,
          phase: result.phase ?? "built",
          files: result.files ? Object.keys(result.files).length : undefined,
        }),
      ),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
