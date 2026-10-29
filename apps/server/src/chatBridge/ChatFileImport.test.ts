import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import type { ChatInboundFile } from "./ChatBridgeCore.ts";
import { importChatFiles } from "./ChatFileImport.ts";

const layerTest = ServerConfig.layerTest(process.cwd(), { prefix: "t3-chat-file-import-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const file = (overrides: Partial<ChatInboundFile>): ChatInboundFile => ({
  name: "trace.log",
  mimeType: "text/plain",
  sizeBytes: 5,
  fetch: async () => new TextEncoder().encode("hello"),
  ...overrides,
});

it.effect("stores chat files as pending attachments the next turn claims", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const result = yield* importChatFiles([
      file({}),
      file({ name: "shot.png", mimeType: "image/png", sizeBytes: 4, fetch: async () => png }),
    ]);
    assert.deepStrictEqual(result.skipped, []);
    const [log, image] = result.attachments;
    assert.deepInclude(log, {
      type: "file",
      name: "trace.log",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    assert.deepInclude(image, {
      type: "image",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 4,
    });
    assert.match(log?.id ?? "", /^pending-/);

    const stored = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: log!,
    });
    assert.strictEqual(yield* fileSystem.readFileString(stored!), "hello");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("skips files it cannot download or that are too large, without fetching big ones", () =>
  Effect.gen(function* () {
    let fetchedBig = false;
    const result = yield* importChatFiles([
      file({
        name: "huge.zip",
        sizeBytes: 60 * 1024 * 1024,
        fetch: async () => {
          fetchedBig = true;
          return new Uint8Array(1);
        },
      }),
      file({ name: "private.pdf", fetch: () => Promise.reject(new Error("missing files:read")) }),
      file({ name: "empty.txt", fetch: async () => new Uint8Array(0) }),
    ]);
    assert.deepStrictEqual(result.attachments, []);
    assert.deepStrictEqual(result.skipped, [
      { name: "huge.zip", reason: "larger than 50 MB" },
      { name: "private.pdf", reason: "download failed" },
      { name: "empty.txt", reason: "empty" },
    ]);
    assert.isFalse(fetchedBig);
  }).pipe(Effect.provide(layerTest)),
);
