/**
 * One agent in a sidebar: a large row with its colored icon tile, its name,
 * and its role or live status, with its open tasks folded underneath. Agents
 * mode lists every agent this way, and Work mode shows Firstmate the same
 * way, so an agent never looks like an ordinary chat.
 */
import type { EnvironmentId, FirstmateTask, ProjectIconColor, ThreadId } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { type MouseEvent, type ReactElement, type ReactNode, cloneElement, useState } from "react";

import { cn } from "~/lib/utils";
import { SidebarMenuItem } from "../ui/sidebar";
import { AgentAvatar } from "./AgentAvatar";
import { AgentTaskTree } from "./AgentTaskTree";

export const AGENT_ROW_CLASS =
  "flex h-14 w-full cursor-pointer items-center gap-3 rounded-xl pr-9 pl-2 text-left outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset active:bg-sidebar-row-active";

export function AgentSidebarRow({
  environmentId,
  icon,
  color,
  name,
  subtitle,
  trailing,
  active,
  link,
  coordinatorThreadId,
  tasks,
  activeRouteKey,
  defaultExpanded,
  onContextMenu,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly icon: string;
  readonly color: ProjectIconColor;
  readonly name: string;
  readonly subtitle: ReactNode;
  readonly trailing?: ReactNode;
  readonly active: boolean;
  /** The row's own element, a link or a button; the row's content goes inside it. */
  readonly link: ReactElement<{ className?: string; children?: ReactNode }>;
  readonly coordinatorThreadId: ThreadId | null;
  readonly tasks: readonly FirstmateTask[] | null;
  readonly activeRouteKey: string | null;
  readonly defaultExpanded: boolean;
  readonly onContextMenu?: (event: MouseEvent) => void;
  readonly className?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const canExpand = coordinatorThreadId !== null && tasks !== null;
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
      {canExpand ? (
        <button
          type="button"
          aria-label={expanded ? `Hide ${name}'s tasks` : `Show ${name}'s tasks`}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="absolute top-7 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : null}
      {canExpand && expanded ? (
        <AgentTaskTree
          environmentId={environmentId}
          coordinatorThreadId={coordinatorThreadId}
          tasks={tasks}
          activeRouteKey={activeRouteKey}
        />
      ) : null}
    </SidebarMenuItem>
  );
}
