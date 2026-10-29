/**
 * Turns files attached to a chat message into pending T3 attachments, the
 * same records a composer upload makes, so a launch or send claims them.
 */
import {
  type ChatAttachment,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { attachmentFileExtension, createPendingAttachmentId } from "../attachmentStore.ts";
import { storeAttachmentUpload } from "../assets/AttachmentUpload.ts";
import type { ChatImportedFiles, ChatInboundFile } from "./ChatBridgeCore.ts";

const NAME_LIMIT = 255;
const MIME_LIMIT = 100;
const MAX_MB = PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024);

function attachmentName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "file" : trimmed.slice(0, NAME_LIMIT);
}

function mimeTypeOf(file: ChatInboundFile): string {
  const mimeType = file.mimeType?.trim().toLowerCase() ?? "";
  return mimeType === "" || mimeType.length > MIME_LIMIT ? "application/octet-stream" : mimeType;
}

/** Supported images under the image limit go to the model as images; everything else as a file. */
function attachmentType(mimeType: string, sizeBytes: number): "image" | "file" {
  return isProviderSendTurnSupportedImageMimeType(mimeType) &&
    sizeBytes <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
    ? "image"
    : "file";
}

const importOne = Effect.fn("ChatFileImport.importOne")(function* (file: ChatInboundFile) {
  const name = attachmentName(file.name);
  if (file.sizeBytes !== undefined && file.sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    return { skipped: { name, reason: `larger than ${MAX_MB} MB` } } as const;
  }
  const fetch = file.fetch;
  if (fetch === undefined) return { skipped: { name, reason: "no download link" } } as const;
  const downloaded = yield* Effect.tryPromise(() => fetch()).pipe(Effect.result);
  if (downloaded._tag === "Failure") {
    yield* Effect.logWarning("Could not download a chat file", {
      name,
      error: String(downloaded.failure.cause),
    });
    return { skipped: { name, reason: "download failed" } } as const;
  }
  const bytes = downloaded.success;
  if (bytes.byteLength === 0) return { skipped: { name, reason: "empty" } } as const;
  if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    return { skipped: { name, reason: `larger than ${MAX_MB} MB` } } as const;
  }

  const mimeType = mimeTypeOf(file);
  const type = attachmentType(mimeType, bytes.byteLength);
  const attachmentId = createPendingAttachmentId(
    type === "file" ? attachmentFileExtension(name) : undefined,
  );
  const stored = yield* storeAttachmentUpload(
    {
      version: 1,
      kind: "attachment-upload",
      type,
      attachmentId,
      name,
      mimeType,
      sizeBytes: bytes.byteLength,
      expiresAt: 0,
    },
    bytes,
  );
  if (!stored.ok) return { skipped: { name, reason: "could not be saved" } } as const;
  const attachment: ChatAttachment = {
    type,
    id: attachmentId,
    name,
    mimeType,
    sizeBytes: bytes.byteLength,
  };
  return { attachment } as const;
});

export const importChatFiles = Effect.fn("ChatFileImport.importChatFiles")(function* (
  files: ReadonlyArray<ChatInboundFile>,
) {
  const attachments: Array<ChatAttachment> = [];
  const skipped: Array<{ readonly name: string; readonly reason: string }> = [];
  for (const file of files) {
    const result = yield* importOne(file);
    if ("attachment" in result) attachments.push(result.attachment);
    else skipped.push(result.skipped);
  }
  return { attachments, skipped } satisfies ChatImportedFiles;
});
