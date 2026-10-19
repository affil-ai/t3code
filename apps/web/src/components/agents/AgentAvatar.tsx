/**
 * An agent's icon on a colored tile, the way Grok Bot shows its bots. The
 * color comes from the project icon palette so it matches project tiles.
 */
import type { EnvironmentId, ProjectIconColor } from "@t3tools/contracts";
import { useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { projectIconColorClassName } from "~/projectIconColors";
import { FirstmateIcon } from "../firstmate/firstmateIcons";

export function AgentAvatar({
  icon,
  color,
  className,
  iconClassName,
  environmentId,
  avatarAttachmentId,
}: {
  readonly icon: string;
  readonly color: ProjectIconColor;
  readonly className?: string;
  readonly iconClassName?: string;
  readonly environmentId?: EnvironmentId | undefined;
  readonly avatarAttachmentId?: string | undefined;
}) {
  const fallback = <FirstmateIcon icon={icon} className={cn("size-5", iconClassName)} />;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl",
        projectIconColorClassName(color),
        className,
      )}
      style={{ backgroundColor: "color-mix(in srgb, currentColor 16%, transparent)" }}
    >
      {environmentId !== undefined && avatarAttachmentId !== undefined ? (
        <AgentImage
          key={`${environmentId}:${avatarAttachmentId}`}
          environmentId={environmentId}
          attachmentId={avatarAttachmentId}
          fallback={fallback}
        />
      ) : (
        fallback
      )}
    </span>
  );
}

function AgentImage({
  environmentId,
  attachmentId,
  fallback,
}: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly fallback: React.ReactNode;
}) {
  const asset = useAssetUrlState(environmentId, { _tag: "attachment", attachmentId });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (asset._tag !== "Success" || asset.url === failedUrl) return fallback;
  return (
    <img
      src={asset.url}
      alt=""
      className="size-full object-cover"
      onError={() => setFailedUrl(asset.url)}
    />
  );
}
