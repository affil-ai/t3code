import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type EnvironmentId,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";
import { useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { attachmentEnvironment } from "~/state/attachments";
import { readPreparedConnection, useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";

/** Pending uploads belong to this form. Saving copies them before the form closes. */
export function AgentAvatarUpload({
  environmentId,
  value,
  disabled,
  onChange,
  onPendingChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: string | null;
  readonly disabled: boolean;
  readonly onChange: (value: string | null) => void;
  readonly onPendingChange: (pending: boolean) => void;
}) {
  const canUpload = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const active = useRef(true);
  const abort = useRef<(() => void) | null>(null);
  const uploads = useRef(new Set<string>());
  useEffect(() => {
    active.current = true;
    const ownedUploads = uploads.current;
    const release = (attachmentId: string) =>
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId,
        attachmentId,
      });
    return () => {
      active.current = false;
      abort.current?.();
      for (const attachmentId of ownedUploads) release(attachmentId);
    };
  }, [environmentId]);

  const upload = async (file: File) => {
    if (uploading || disabled || !canUpload) return;
    const mimeType = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
      (type) => type === file.type.toLowerCase(),
    );
    if (!mimeType || file.size === 0 || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      setError("Choose a PNG, JPEG, GIF, or WebP image of at most 10 MB.");
      return;
    }
    setError(null);
    setUploading(true);
    onPendingChange(true);
    try {
      const result = await runAttachmentUploadCycle({
        registry: appAtomRegistry,
        createUploadUrl: attachmentEnvironment.createUploadUrl,
        remove: attachmentEnvironment.remove,
        environmentId,
        upload: { name: file.name, mimeType, sizeBytes: file.size },
        resolveUploadUrl: (relativeUrl) => {
          const connection = readPreparedConnection(environmentId);
          return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
        },
        onMinted: (attachmentId) => {
          if (!active.current) return "cancel";
          uploads.current.add(attachmentId);
          return "continue";
        },
        onTransferStart: (cancel) => {
          abort.current = cancel;
          if (!active.current) cancel();
        },
        transport: (url) => {
          const controller = new AbortController();
          return {
            abort: () => controller.abort(),
            done: fetch(url, {
              method: "POST",
              headers: { "Content-Type": mimeType },
              body: file,
              signal: controller.signal,
            }).then((response) => {
              if (!response.ok) throw new Error("Avatar upload failed.");
            }),
          };
        },
      });
      if (!active.current) return;
      if (result.status === "uploaded") onChange(result.attachmentId);
      else setError("Could not upload the image. Try again.");
    } catch {
      if (active.current) setError("Could not upload the image. Try again.");
    } finally {
      abort.current = null;
      if (active.current) {
        setUploading(false);
        onPendingChange(false);
      }
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          name="agent-avatar"
          aria-label="Agent image"
          accept={PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.join(",")}
          hidden
          disabled={disabled || uploading || !canUpload}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void upload(file);
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || uploading || !canUpload}
          onClick={() => input.current?.click()}
        >
          {uploading ? "Uploading…" : value === null ? "Upload image" : "Replace image"}
        </Button>
        {value !== null ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || uploading}
            onClick={() => onChange(null)}
          >
            Remove image
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
