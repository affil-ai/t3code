/**
 * The user's standup to-dos at the top of the Work sidebar, whichever agent
 * is selected. Each row opens the work wherever it lives; opening another
 * agent's worker chat switches the sidebar to that agent. Hidden on servers
 * without `standup.subscribe` and while the list is empty.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AgentProfile,
  type EnvironmentId,
  type StandupItem,
  standupProgress,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useStandup } from "~/state/agents";
import { useFirstmateTaskFocusStore } from "../firstmate/firstmateTaskFocusStore";
import { SidebarGroup, useSidebar } from "../ui/sidebar";
import { WorkerStatusDot } from "./AgentTaskTree";
import { standupNeedsYouCount, standupStartedLabel, standupTarget } from "./standupSection.logic";

function StandupRow({
  environmentId,
  item,
  agents,
  activeRouteKey,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: StandupItem;
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly activeRouteKey: string | null;
  readonly now: Date;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const target = standupTarget(item, agents);
  const owner = item.agentId === null ? null : agents.find((agent) => agent.id === item.agentId);
  const workerThreadId = item.task?.workerThreadId ?? null;
  const active = workerThreadId !== null && activeRouteKey === `${environmentId}:${workerThreadId}`;
  const detail = [owner?.name, standupStartedLabel(item.startedAt, now)]
    .filter(Boolean)
    .join(" · ");
  const open = () => {
    if (target === null) return;
    if (isMobile) setOpenMobile(false);
    if (target.kind === "task") {
      const ref = scopeThreadRef(environmentId, target.coordinatorThreadId);
      useFirstmateTaskFocusStore
        .getState()
        .requestTask({ threadKey: scopedThreadKey(ref), taskId: target.taskId });
      useRightPanelStore.getState().open(ref, "firstmate");
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId: target.kind === "task" ? target.coordinatorThreadId : target.threadId,
      },
    });
  };
  return (
    <li data-standup-item-id={item.id}>
      <button
        type="button"
        onClick={open}
        disabled={target === null}
        aria-label={`Open ${item.text}`}
        className={cn(
          "flex w-full min-w-0 cursor-pointer flex-col justify-center gap-0.5 rounded-md px-2 py-1.5 text-left outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset disabled:cursor-default",
          active && "bg-sidebar-row-selected",
        )}
        {...(active ? { "data-active": true } : {})}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          {standupProgress(item.task, null) === "needs_you" ? (
            <span role="img" aria-label="Needs your input" className="shrink-0 text-destructive">
              <span aria-hidden className="text-sm font-bold leading-none">
                !
              </span>
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
            {item.text}
          </span>
          {workerThreadId !== null ? (
            <WorkerStatusDot environmentId={environmentId} workerThreadId={workerThreadId} />
          ) : null}
        </span>
        <span className="truncate text-xs leading-4 text-sidebar-muted-foreground/80">
          {item.task === null ? `No task yet${detail ? ` · ${detail}` : ""}` : detail}
        </span>
      </button>
    </li>
  );
}

export function StandupSection({
  environmentId,
  agents,
  activeRouteKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly activeRouteKey: string | null;
}) {
  const standup = useStandup(environmentId);
  const now = new Date(useNowMinute());
  const items = standup.data?.items ?? [];
  if (items.length === 0) return null;
  const needsYou = standupNeedsYouCount(items);
  return (
    <SidebarGroup aria-label="Standup" className="mb-3">
      <section aria-label="Standup">
        <h3 className="mb-1 flex h-6 items-center gap-1.5 pr-1.5 pl-2 text-xs font-medium text-sidebar-muted-foreground/80">
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
          <span className="truncate">Standup</span>
          <span className="tabular-nums">{items.length}</span>
          {needsYou > 0 ? (
            <span className="ml-auto text-destructive tabular-nums">{needsYou} need you</span>
          ) : null}
        </h3>
        <ul className="flex flex-col">
          {items.map((item) => (
            <StandupRow
              key={item.id}
              environmentId={environmentId}
              item={item}
              agents={agents}
              activeRouteKey={activeRouteKey}
              now={now}
            />
          ))}
        </ul>
      </section>
    </SidebarGroup>
  );
}
