/**
 * An agent's open tasks in the sidebar, in the Tasks panel's sections
 * (Ready for deployment first, followed by attention and other lifecycle
 * sections). A task with a worker opens the worker's chat, with a dot for
 * what the worker is doing. A Planning task is a card with its title, intent,
 * and next step. A Backlog task shows the last activity age of its worker
 * instead of its description. Closed tasks stay in the panel.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FirstmateTask, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { type FirstmateColumnId, mapFirstmateBoard } from "../firstmate/firstmateBoard.logic";
import { useFirstmateTaskFocusStore } from "../firstmate/firstmateTaskFocusStore";
import { COLUMN_DOT, COLUMN_LABELS, taskNextStep } from "../firstmate/firstmateTasksShared";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebar } from "../ui/sidebar";

/** The intent's first line, short enough for a sidebar card. */
function intentExcerpt(intent: string, limit = 90): string {
  const line = intent.trim().split("\n")[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

function PlanningCard({
  environmentId,
  coordinatorThreadId,
  task,
  activeRouteKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
  readonly task: FirstmateTask;
  readonly activeRouteKey: string | null;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const nextStep = taskNextStep(task);
  const excerpt = intentExcerpt(task.intent);
  const active =
    task.workerThreadId !== null && activeRouteKey === `${environmentId}:${task.workerThreadId}`;
  const open = () => {
    if (isMobile) setOpenMobile(false);
    if (task.workerThreadId !== null) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: task.workerThreadId },
      });
      return;
    }
    const threadRef = scopeThreadRef(environmentId, coordinatorThreadId);
    useFirstmateTaskFocusStore
      .getState()
      .requestTask({ threadKey: scopedThreadKey(threadRef), taskId: task.id });
    useRightPanelStore.getState().open(threadRef, "firstmate");
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: coordinatorThreadId },
    });
  };
  return (
    <li>
      <button
        type="button"
        onClick={open}
        aria-label={`Open ${task.title}`}
        data-testid="planning-task-card"
        className={cn(
          "flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset",
          active && "bg-sidebar-row-selected",
        )}
        {...(active ? { "data-active": true } : {})}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
            {task.title}
          </span>
          {task.workerThreadId !== null ? (
            <WorkerStatusDot environmentId={environmentId} workerThreadId={task.workerThreadId} />
          ) : null}
        </span>
        {task.status === "backlog" ? (
          <span className="truncate text-xs leading-4 text-sidebar-muted-foreground/80">
            <BacklogActivity environmentId={environmentId} workerThreadId={task.workerThreadId} />
          </span>
        ) : excerpt ? (
          <span className="line-clamp-2 text-xs leading-4 text-sidebar-muted-foreground/80">
            {excerpt}
          </span>
        ) : null}
        {task.status !== "backlog" && nextStep !== null ? (
          <span className="truncate text-2xs text-sidebar-muted-foreground/80">{nextStep}</span>
        ) : null}
      </button>
    </li>
  );
}

function BacklogActivity({
  environmentId,
  workerThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly workerThreadId: ThreadId | null;
}) {
  const shell = useThreadShell(
    workerThreadId === null ? null : scopeThreadRef(environmentId, workerThreadId),
  );
  useNowMinute();
  if (workerThreadId === null) return "No worker yet";
  if (shell === null) return "Worker activity unavailable";
  const label = formatRelativeTimeLabel(shell.updatedAt);
  if (!label) return "Worker activity unavailable";
  return <time dateTime={shell.updatedAt}>Last active {label}</time>;
}

const OPEN_COLUMNS: Exclude<FirstmateColumnId, "done">[] = [
  "ready",
  "needs-you",
  "planning",
  "in-progress",
  "in-review",
  "backlog",
];

function WorkerStatusDot({
  environmentId,
  workerThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly workerThreadId: ThreadId;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, workerThreadId));
  const status = shell === null ? null : resolveThreadStatusPill({ thread: shell });
  if (status === null) return null;
  return (
    <span
      aria-label={status.label}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status.dotClass,
        status.pulse && "animate-pulse",
      )}
    />
  );
}

function TaskRow({
  environmentId,
  coordinatorThreadId,
  task,
  activeRouteKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
  readonly task: FirstmateTask;
  readonly activeRouteKey: string | null;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const threadId = task.workerThreadId ?? coordinatorThreadId;
  const active = task.workerThreadId !== null && activeRouteKey === `${environmentId}:${threadId}`;
  const nextStep = taskNextStep(task);
  return (
    <li>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId }}
              onClick={(event) => {
                if (
                  isMobile &&
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                )
                  setOpenMobile(false);
              }}
              className={cn(
                "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/80 outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset",
                active && "bg-sidebar-row-selected text-sidebar-foreground",
              )}
              {...(active ? { "data-active": true } : {})}
            />
          }
        >
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          {task.workerThreadId !== null ? (
            <WorkerStatusDot environmentId={environmentId} workerThreadId={task.workerThreadId} />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right" className="max-w-72">
          <span className="block font-medium">{task.title}</span>
          {nextStep !== null ? <span className="block opacity-80">{nextStep}</span> : null}
          {task.workerThreadId === null ? (
            <span className="block opacity-60">No worker yet</span>
          ) : null}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

export function AgentTaskTree({
  environmentId,
  coordinatorThreadId,
  tasks,
  activeRouteKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
  readonly tasks: readonly FirstmateTask[];
  readonly activeRouteKey: string | null;
}) {
  const columns = mapFirstmateBoard(tasks);
  const sections = OPEN_COLUMNS.filter((column) => columns[column].length > 0);
  if (sections.length === 0) {
    return <p className="px-2 py-1 text-sm text-sidebar-muted-foreground/70">No open tasks</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {sections.map((column) => (
        <section key={column} aria-label={COLUMN_LABELS[column]}>
          <h3 className="mb-1 flex h-6 items-center gap-1.5 pr-1.5 pl-2 text-xs font-medium text-sidebar-muted-foreground/80">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", COLUMN_DOT[column])}
            />
            <span className="truncate">{COLUMN_LABELS[column]}</span>
            <span className="tabular-nums">{columns[column].length}</span>
          </h3>
          <ul className="flex flex-col">
            {columns[column].map((task) =>
              column === "planning" || column === "backlog" || task.workerThreadId === null ? (
                <PlanningCard
                  key={task.id}
                  environmentId={environmentId}
                  coordinatorThreadId={coordinatorThreadId}
                  task={task}
                  activeRouteKey={activeRouteKey}
                />
              ) : (
                <TaskRow
                  key={task.id}
                  environmentId={environmentId}
                  coordinatorThreadId={coordinatorThreadId}
                  task={task}
                  activeRouteKey={activeRouteKey}
                />
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
