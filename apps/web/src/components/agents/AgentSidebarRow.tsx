/**
 * One agent in a sidebar: a large row with its colored icon tile, its name,
 * and its role or live status. The Work sidebar shows the selected agent
 * this way, and the agent switcher lists every agent the same way, so an
 * agent never looks like an ordinary chat.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { AgentProfile, EnvironmentId, ProjectIconColor } from "@t3tools/contracts";
import { type MouseEvent, type ReactElement, type ReactNode, cloneElement } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { SidebarMenuItem } from "../ui/sidebar";
import { AgentAvatar } from "./AgentAvatar";

/** The role on one line, or the chat's live status when it is doing something. */
export function AgentRowSubtitle({
  environmentId,
  agent,
  fallback = "Agent",
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: Pick<AgentProfile, "coordinatorThreadId" | "role">;
  readonly fallback?: string;
}) {
  const shell = useThreadShell(
    agent.coordinatorThreadId === null
      ? null
      : scopeThreadRef(environmentId, agent.coordinatorThreadId),
  );
  const status = shell === null ? null : resolveThreadStatusPill({ thread: shell });
  const live =
    status !== null &&
    (status.label === "Working" ||
      status.label === "Connecting" ||
      status.label === "Pending Approval" ||
      status.label === "Awaiting Input" ||
      status.label === "Failed");
  if (live) {
    return (
      <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", status.colorClass)}>
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status.dotClass,
            status.pulse && "animate-pulse",
          )}
        />
        <span className="truncate">{status.label}</span>
      </span>
    );
  }
  if (agent.coordinatorThreadId === null) {
    return <span className="truncate text-xs text-sidebar-muted-foreground/70">Not started</span>;
  }
  return (
    <span className="truncate text-xs text-sidebar-muted-foreground/80">
      {agent.role.split("\n")[0] || fallback}
    </span>
  );
}

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
