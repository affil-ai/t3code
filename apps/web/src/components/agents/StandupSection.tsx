/**
 * The Standup section of the Work sidebar: the user's open standup tasks,
 * ahead of the status sections. Firstmate's sidebar lists every agent's;
 * another agent's lists its own. A row shows the owner's icon and opens the
 * work wherever it lives; opening another agent's worker chat switches the
 * sidebar to that agent. The standup dates are in the task's details.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AGENT_DEFAULT_COLOR,
  type AgentProfile,
  type EnvironmentId,
  standupProgress,
} from "@t3tools/contracts";
import { COLUMN_LABELS } from "@t3tools/client-runtime/firstmate/tasks";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import type { StandupTaskRow } from "~/state/agents";
import { COLUMN_DOT } from "../firstmate/firstmateTasksShared";
import { useFirstmateTaskFocusStore } from "../firstmate/firstmateTaskFocusStore";
import { useClaimSidebarRouteReveal } from "../sidebar/routeReveal";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentAvatar } from "./AgentAvatar";
import { WorkerStatusDot } from "./AgentTaskTree";
import { standupTarget } from "./standupSection.logic";

function StandupRow({
  environmentId,
  row,
  agents,
  activeRouteKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly row: StandupTaskRow;
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly activeRouteKey: string | null;
}) {
  const { task, agent } = row;
  const navigate = useNavigate();
  const claimRouteReveal = useClaimSidebarRouteReveal();
  const { isMobile, setOpenMobile } = useSidebar();
  const target = standupTarget(task, agent.id, agents);
  const active =
    task.workerThreadId !== null && activeRouteKey === `${environmentId}:${task.workerThreadId}`;
  const open = () => {
    if (target === null) return;
    if (isMobile) setOpenMobile(false);
    const threadId = target.kind === "task" ? target.coordinatorThreadId : target.threadId;
    claimRouteReveal(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
    if (target.kind === "task") {
      const ref = scopeThreadRef(environmentId, target.coordinatorThreadId);
      useFirstmateTaskFocusStore
        .getState()
        .requestTask({ threadKey: scopedThreadKey(ref), taskId: target.taskId });
      useRightPanelStore.getState().open(ref, "firstmate");
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  };
  return (
    <li data-task-id={task.id}>
      <button
        type="button"
        onClick={open}
        disabled={target === null}
        aria-label={`Open ${task.title}, ${agent.name}`}
        className={cn(
          "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground/90 outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset disabled:cursor-default",
          active && "bg-sidebar-row-selected",
        )}
        {...(active ? { "data-active": true } : {})}
      >
        <Tooltip>
          <TooltipTrigger render={<span role="img" aria-label={agent.name} className="shrink-0" />}>
            <AgentAvatar
              icon={agent.icon}
              color={agent.color ?? AGENT_DEFAULT_COLOR}
              environmentId={environmentId}
              avatarAttachmentId={agent.avatarAttachmentId}
              className="size-4 rounded-sm"
              iconClassName="size-3"
            />
          </TooltipTrigger>
          <TooltipPopup side="right">{agent.name}</TooltipPopup>
        </Tooltip>
        {standupProgress(task, null) === "needs_you" ? (
          <span role="img" aria-label="Needs your input" className="shrink-0 text-destructive">
            <span aria-hidden className="text-sm font-bold leading-none">
              !
            </span>
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        {task.workerThreadId !== null ? (
          <WorkerStatusDot environmentId={environmentId} workerThreadId={task.workerThreadId} />
        ) : null}
      </button>
    </li>
  );
}

export function StandupSection({
  environmentId,
  rows,
  agents,
  activeRouteKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly rows: ReadonlyArray<StandupTaskRow>;
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly activeRouteKey: string | null;
}) {
  if (rows.length === 0) return null;
  return (
    <section aria-label={COLUMN_LABELS.standup} className="mb-3">
      <h3 className="mb-1 flex h-6 items-center gap-1.5 pr-1.5 pl-2 text-xs font-medium text-sidebar-muted-foreground/80">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", COLUMN_DOT.standup)} />
        <span className="truncate">{COLUMN_LABELS.standup}</span>
        <span className="tabular-nums">{rows.length}</span>
      </h3>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <StandupRow
            key={row.task.id}
            environmentId={environmentId}
            row={row}
            agents={agents}
            activeRouteKey={activeRouteKey}
          />
        ))}
      </ul>
    </section>
  );
}
