import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon, FolderOpenIcon } from "lucide-react";
import { useState } from "react";
import { resolveEnvironmentHttpUrl } from "../environments/runtime";

const loadedProjectFaviconSrcs = new Set<string>();
const PROJECT_FAVICON_CACHE_VERSION = "2";

// Single source of truth for the per-project favicon URL, shared by the sidebar
// icon and the document (browser tab) favicon so both resolve identically.
export function resolveProjectFaviconUrl(input: {
  environmentId: EnvironmentId;
  cwd: string;
}): string | null {
  try {
    return resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: "/api/project-favicon",
      searchParams: {
        cwd: input.cwd,
        v: PROJECT_FAVICON_CACHE_VERSION,
      },
    });
  } catch {
    return null;
  }
}

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string;
  isActive?: boolean;
}) {
  return (
    <ResolvedProjectFavicon
      environmentId={input.environmentId}
      cwd={input.cwd}
      {...(input.isActive !== undefined ? { isActive: input.isActive } : {})}
      {...(input.className !== undefined ? { className: input.className } : {})}
    />
  );
}

function ResolvedProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string;
  isActive?: boolean;
}) {
  const src = resolveProjectFaviconUrl({
    environmentId: input.environmentId,
    cwd: input.cwd,
  });
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    src && loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  if (!src) {
    return input.isActive ? (
      <FolderOpenIcon className={`size-3.5 shrink-0 text-foreground/90 ${input.className ?? ""}`} />
    ) : (
      <FolderIcon
        className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
      />
    );
  }

  return (
    <>
      {status !== "loaded" ? (
        input.isActive ? (
          <FolderOpenIcon
            className={`size-3.5 shrink-0 text-foreground/90 ${input.className ?? ""}`}
          />
        ) : (
          <FolderIcon
            className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
          />
        )
      ) : null}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${input.className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
