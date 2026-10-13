/**
 * A task's review artifacts in the Tasks panel: the links and screenshots
 * Firstmate attached for the user to check. Cards show a compact strip of
 * thumbnails and link chips; the task detail shows each one with its caption.
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

interface ArtifactsProps {
  readonly environmentId: EnvironmentId;
  /** The coordinator thread; the server signs media files against a thread. */
  readonly threadId: ThreadId;
  readonly artifacts: ReadonlyArray<FirstmateTaskArtifact>;
}

function stopPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function useArtifactImageUrl(environmentId: EnvironmentId, threadId: ThreadId, path: string) {
  const resource = useMemo(
    () => ({ _tag: "media-file" as const, threadId, path }),
    [threadId, path],
  );
  return useAssetUrlState(environmentId, resource);
}

function ArtifactImage({
  environmentId,
  threadId,
  artifact,
  className,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly artifact: FirstmateTaskArtifact;
  readonly className: string;
  readonly onOpen: (src: string) => void;
}) {
  const url = useArtifactImageUrl(environmentId, threadId, artifact.url);
  if (url._tag === "Loading") return <Skeleton className={className} />;
  if (url._tag !== "Success") {
    return (
      <span
        className={cn(
          className,
          "flex items-center justify-center bg-muted/60 text-muted-foreground",
        )}
        title={`${artifact.label} could not be loaded`}
      >
        <ImageOffIcon className="size-3.5" />
      </span>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        className,
        "cursor-zoom-in overflow-hidden focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
      )}
      aria-label={`View ${artifact.label}`}
      title={artifact.caption ? `${artifact.label}: ${artifact.caption}` : artifact.label}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(url.url);
      }}
    >
      <img src={url.url} alt={artifact.label} className="size-full object-cover object-top" />
    </button>
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

const CHIP_CLASS =
  "inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The card's strip: screenshot thumbnails, then link chips. */
export function FirstmateArtifactStrip({ environmentId, threadId, artifacts }: ArtifactsProps) {
  const viewer = useImageViewer();
  const images = artifacts.filter((artifact) => artifact.kind === "image");
  const links = artifacts.filter((artifact) => artifact.kind === "link");
  if (artifacts.length === 0) return null;
  return (
    <div className="pointer-events-auto mt-1.5 space-y-1">
      {images.length > 0 ? (
        <div className="flex gap-1 overflow-x-auto">
          {images.map((artifact) => (
            <ArtifactImage
              key={`${artifact.label}:${artifact.url}`}
              environmentId={environmentId}
              threadId={threadId}
              artifact={artifact}
              className="h-12 w-20 shrink-0 rounded-sm border border-border/60"
              onOpen={(src) => viewer.open(src, artifact.label)}
            />
          ))}
        </div>
      ) : null}
      {links.length > 0 ? (
        <div className="-mx-1 flex min-w-0 flex-wrap gap-x-0.5">
          {links.map((artifact) => (
            <a
              key={`${artifact.label}:${artifact.url}`}
              className={CHIP_CLASS}
              href={artifact.url}
              target="_blank"
              rel="noreferrer"
              title={artifact.caption}
              onClick={stopPropagation}
            >
              <ExternalLinkIcon className="size-3 shrink-0" />
              <span className="truncate">{artifact.label}</span>
            </a>
          ))}
        </div>
      ) : null}
      {viewer.dialog}
    </div>
  );
}

/** The detail view's list: each artifact with its caption, images at full width. */
export function FirstmateArtifactList({ environmentId, threadId, artifacts }: ArtifactsProps) {
  const viewer = useImageViewer();
  return (
    <div className="space-y-3">
      {artifacts.map((artifact) => (
        <div key={`${artifact.label}:${artifact.url}`} className="space-y-1">
          {artifact.kind === "image" ? (
            <>
              <p className="text-sm font-medium text-foreground">{artifact.label}</p>
              <ArtifactImage
                environmentId={environmentId}
                threadId={threadId}
                artifact={artifact}
                className="block aspect-video w-full rounded-md border border-border/60"
                onOpen={(src) => viewer.open(src, artifact.label)}
              />
            </>
          ) : (
            <a
              className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground hover:underline"
              href={artifact.url}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{artifact.label}</span>
            </a>
          )}
          {artifact.caption?.trim() ? (
            <p className="text-xs text-muted-foreground">{artifact.caption}</p>
          ) : null}
        </div>
      ))}
      {viewer.dialog}
    </div>
  );
}
