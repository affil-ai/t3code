/**
 * A task's review artifacts in the Tasks panel: the links and screenshots
 * Firstmate attached for the user to check. They show only in the task
 * detail, each with its caption, so the task list stays clean.
 * Images are files on the server, loaded through signed asset URLs, and open
 * in the image viewer.
 */
import type { EnvironmentId, FirstmateTaskArtifact, ThreadId } from "@t3tools/contracts";
import { ExternalLinkIcon, ImageOffIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { Skeleton } from "../ui/skeleton";
import { useTaskLinkHandlers } from "./FirstmateTaskLinks";

interface ArtifactsProps {
  readonly environmentId: EnvironmentId;
  /** The coordinator thread; the server signs media files against a thread. */
  readonly threadId: ThreadId;
  readonly artifacts: ReadonlyArray<FirstmateTaskArtifact>;
}

function useArtifactImageUrl(environmentId: EnvironmentId, threadId: ThreadId, path: string) {
  const resource = useMemo(
    () => ({ _tag: "media-file" as const, threadId, path }),
    [threadId, path],
  );
  return useAssetUrlState(environmentId, resource);
}

/** A 16:9 framed screenshot; the frame holds its place while the URL loads. */
const IMAGE_FRAME_CLASS =
  "block aspect-video w-full overflow-hidden rounded-md border border-border/60";

function ArtifactImage({
  environmentId,
  threadId,
  artifact,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly artifact: FirstmateTaskArtifact;
  readonly onOpen: (src: string) => void;
}) {
  const url = useArtifactImageUrl(environmentId, threadId, artifact.url);
  if (url._tag === "Loading") {
    return (
      <span className={IMAGE_FRAME_CLASS}>
        <Skeleton className="size-full" />
      </span>
    );
  }
  if (url._tag !== "Success") {
    return (
      <span
        className={cn(
          IMAGE_FRAME_CLASS,
          "flex items-center justify-center gap-1.5 bg-muted/60 text-xs text-muted-foreground",
        )}
      >
        <ImageOffIcon className="size-3.5" />
        Image unavailable
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        IMAGE_FRAME_CLASS,
        "cursor-zoom-in focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
      )}
      aria-label={`View ${artifact.label}`}
      onClick={() => onOpen(url.url)}
    >
      <img src={url.url} alt={artifact.label} className="size-full object-cover object-top" />
    </button>
  );
}

/**
 * A link artifact. It opens like a link in chat: a click follows the "Open links
 * in" setting, and a right-click offers the integrated browser, the system
 * browser, or copying the link.
 */
function ArtifactLink({
  environmentId,
  artifact,
}: {
  readonly environmentId: EnvironmentId;
  readonly artifact: FirstmateTaskArtifact;
}) {
  const handlers = useTaskLinkHandlers(environmentId, artifact.url);
  const content = (
    <>
      <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{artifact.label}</span>
    </>
  );
  const className =
    "flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground hover:underline";
  if (handlers === null) {
    // Not a web link the panel can route (for example a custom scheme): leave it to the shell.
    return (
      <a className={className} href={artifact.url} target="_blank" rel="noreferrer">
        {content}
      </a>
    );
  }
  return (
    <a
      className={className}
      href={handlers.href}
      target="_blank"
      rel="noreferrer"
      onClick={handlers.onClick}
      onContextMenu={handlers.onContextMenu}
    >
      {content}
    </a>
  );
}

function useImageViewer() {
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const dialog = preview ? (
    <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />
  ) : null;
  return {
    dialog,
    open: (src: string, name: string) => setPreview({ images: [{ src, name }], index: 0 }),
  };
}

/** The detail view's list: each artifact with its caption, images at full width. */
export function FirstmateArtifactList({ environmentId, threadId, artifacts }: ArtifactsProps) {
  const viewer = useImageViewer();
  return (
    <div className="space-y-1.5">
      {artifacts.map((artifact) => (
        <div
          key={`${artifact.label}:${artifact.url}`}
          className={cn(
            "space-y-1",
            artifact.kind !== "image" && "rounded-md border border-border/70 px-2.5 py-2",
          )}
        >
          {artifact.kind === "image" ? (
            <>
              <p className="text-sm font-medium text-foreground">{artifact.label}</p>
              <ArtifactImage
                environmentId={environmentId}
                threadId={threadId}
                artifact={artifact}
                onOpen={(src) => viewer.open(src, artifact.label)}
              />
            </>
          ) : (
            <ArtifactLink environmentId={environmentId} artifact={artifact} />
          )}
          {artifact.caption?.trim() ? (
            <p className="text-xs leading-4 text-muted-foreground">{artifact.caption}</p>
          ) : null}
        </div>
      ))}
      {viewer.dialog}
    </div>
  );
}
