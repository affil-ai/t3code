/**
 * An agent's icon on a colored tile, the way Grok Bot shows its bots. The
 * color comes from the project icon palette so it matches project tiles.
 */
import type { ProjectIconColor } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { projectIconColorClassName } from "~/projectIconColors";
import { FirstmateIcon } from "../firstmate/firstmateIcons";

export function AgentAvatar({
  icon,
  color,
  className,
  iconClassName,
}: {
  readonly icon: string;
  readonly color: ProjectIconColor;
  readonly className?: string;
  readonly iconClassName?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-xl",
        projectIconColorClassName(color),
        className,
      )}
      style={{ backgroundColor: "color-mix(in srgb, currentColor 16%, transparent)" }}
    >
      <FirstmateIcon icon={icon} className={cn("size-5", iconClassName)} />
    </span>
  );
}
