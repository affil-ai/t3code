/**
 * One agent in a sidebar: a large row with its colored icon tile, its name,
 * and its role or live status. Agents mode lists every agent this way, and
 * Work mode shows Firstmate the same way, so an agent never looks like an
 * ordinary chat.
 */
import type { ProjectIconColor } from "@t3tools/contracts";
import { type MouseEvent, type ReactElement, type ReactNode, cloneElement } from "react";

import { cn } from "~/lib/utils";
import { SidebarMenuItem } from "../ui/sidebar";
import { AgentAvatar } from "./AgentAvatar";

export const AGENT_ROW_CLASS =
  "flex h-14 w-full cursor-pointer items-center gap-3 rounded-xl pr-2 pl-2 text-left outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset active:bg-sidebar-row-active";

export function AgentSidebarRow({
  icon,
  color,
  name,
  subtitle,
  trailing,
  active,
  link,
  onContextMenu,
  className,
}: {
  readonly icon: string;
  readonly color: ProjectIconColor;
  readonly name: string;
  readonly subtitle: ReactNode;
  readonly trailing?: ReactNode;
  readonly active: boolean;
  /** The row's own element, a link or a button; the row's content goes inside it. */
  readonly link: ReactElement<{ className?: string; children?: ReactNode }>;
  readonly onContextMenu?: (event: MouseEvent) => void;
  readonly className?: string;
}) {
  return (
    <SidebarMenuItem className={cn("mb-1", className)} onContextMenu={onContextMenu}>
      {cloneElement(link, {
        className: cn(AGENT_ROW_CLASS, active && "bg-sidebar-row-selected"),
        children: (
          <>
            <AgentAvatar icon={icon} color={color} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={cn(
                  "truncate text-sm font-medium text-sidebar-foreground",
                  !active && "text-sidebar-foreground/90",
                )}
              >
                {name}
              </span>
              {subtitle}
            </span>
            {trailing}
          </>
        ),
      })}
    </SidebarMenuItem>
  );
}
