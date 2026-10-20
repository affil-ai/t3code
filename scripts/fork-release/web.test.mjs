import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
const test = NodeTest.default;
const assert = NodeAssert.default;
const fs = NodeFSP;
const { join } = NodePath;
const { tmpdir } = NodeOS;
import { inventory, verifyWeb, switchWeb, assertBackend, publicUrl } from "./web.mjs";
import { atomicJson } from "./release.mjs";

const request = {
  schema: 1,
  repository: "affil-ai/t3code",
  commit: "a".repeat(40),
  version: "0.1.0-stable.fork.68",
};
const backend = { serverVersion: request.version, orchestrationProtocolVersion: 2 };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "t3-web-test-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payload = join(root, "payload");
  const previous = join(root, "releases", "old");
  for (const dir of [payload, previous]) await fs.mkdir(join(dir, "assets"), { recursive: true });
  await fs.writeFile(join(payload, "index.html"), '<script src="/assets/new.js"></script>');
  await fs.writeFile(join(payload, "assets/new.js"), "new app");
  await fs.writeFile(join(previous, "index.html"), "old app");
  await fs.writeFile(join(previous, "assets/old.js"), "old lazy chunk");
  await fs.symlink(previous, join(root, "current"));
  await atomicJson(join(payload, "fork-release.json"), {
    ...request,
    url: publicUrl,
    files: await inventory(payload),
  });
  return { root, payload, previous };
}

test("web requires matching backend version and protocol", () => {
  assert.doesNotThrow(() => assertBackend(request, backend));
  assert.throws(() =>
    assertBackend(request, { ...backend, serverVersion: "0.1.0-stable.fork.59" }),
  );
  assert.throws(() => assertBackend(request, { ...backend, orchestrationProtocolVersion: 1 }));
});

test("web metadata detects wrong commit and tampered asset", async (t) => {
  const { payload } = await fixture(t);
  await assert.rejects(verifyWeb(payload, { ...request, commit: "b".repeat(40) }));
  await fs.writeFile(join(payload, "assets/new.js"), "tampered");
  await assert.rejects(verifyWeb(payload, request));
});

test("atomic publication retains old chunks and verifies new metadata", async (t) => {
  const { root, payload, previous } = await fixture(t);
  const receipt = await switchWeb(root, payload, request, async () => backend);
  assert.equal(receipt.previous, previous);
  const current = await fs.realpath(join(root, "current"));
  assert.equal(await fs.readFile(join(current, "assets/old.js"), "utf8"), "old lazy chunk");
  assert.equal(await fs.readFile(join(current, "assets/new.js"), "utf8"), "new app");
  assert.equal((await verifyWeb(current, request)).commit, request.commit);
  assert.equal(await fs.readFile(join(previous, "index.html"), "utf8"), "old app");
  const repeated = await switchWeb(root, payload, request, async () => backend);
  assert.equal(repeated.unchanged, true);
  assert.equal(await fs.realpath(join(root, "current")), current);
});

test("backend changes during staging block publication", async (t) => {
  const { root, payload, previous } = await fixture(t);
  let calls = 0;
  await assert.rejects(
    switchWeb(root, payload, request, async () =>
      ++calls === 1 ? backend : { ...backend, serverVersion: "wrong" },
    ),
  );
  assert.equal(await fs.realpath(join(root, "current")), previous);
});

test("symlinks and source maps cannot enter web payload", async (t) => {
  const { payload } = await fixture(t);
  await fs.symlink("index.html", join(payload, "symlink"));
  await assert.rejects(inventory(payload));
  await fs.unlink(join(payload, "symlink"));
  await fs.writeFile(join(payload, "bundle.js.map"), "{}");
  await assert.rejects(inventory(payload));
});

test("existing publication lock prevents a second writer", async (t) => {
  const { root, payload, previous } = await fixture(t);
  await fs.mkdir(join(root, "publish.lock"));
  await assert.rejects(
    switchWeb(root, payload, request, async () => backend),
    /locked/,
  );
  assert.equal(await fs.realpath(join(root, "current")), previous);
});
