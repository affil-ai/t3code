/**
 * An agent's open tasks in the sidebar, in the Tasks panel's sections
 * (`FIRSTMATE_SECTION_ORDER`, without Done).
 * Attention is marked on the row, not in a duplicate section.
 * A task with a worker opens the worker's chat, with a dot for
 * what the worker is doing. Tasks without a worker open task details and
 * identify when the coordinator owns the next action. Only Backlog tasks
 * have a second line, showing worker activity. Closed tasks stay in the panel.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  firstmateTaskStatus,
  type EnvironmentId,
  type FirstmateTask,
  type ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import { useId, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import {
  adjacentSidebarTask,
  firstmateNeedsYou,
  mapFirstmateBoard,
  OPEN_TASK_COLUMNS,
  sidebarNavigationTasks,
} from "@t3tools/client-runtime/firstmate/board";
import { COLUMN_LABELS } from "@t3tools/client-runtime/firstmate/tasks";
import { useFirstmateTaskFocusStore } from "../firstmate/firstmateTaskFocusStore";
import { COLUMN_DOT } from "../firstmate/firstmateTasksShared";
import { useClaimSidebarRouteReveal } from "../sidebar/routeReveal";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebar } from "../ui/sidebar";
import { useWorkSidebarShortcut } from "./WorkSidebarShortcuts";
import { TaskPriorityStar } from "../firstmate/TaskPriority";

function TaskAttention({ task }: { readonly task: FirstmateTask }) {
  if (!firstmateNeedsYou(task)) return null;
  return (
    <span role="img" aria-label="Needs your input" className="shrink-0 text-destructive">
      <span aria-hidden className="text-sm font-bold leading-none">
        !
      </span>
    </span>
  );
}

function PlanningCard({
  environmentId,
  coordinatorThreadId,
  task,
  activeRouteKey,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
  readonly task: FirstmateTask;
  readonly activeRouteKey: string | null;
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const backlog = firstmateTaskStatus(task) === "backlog";
  const active =
    task.workerThreadId !== null && activeRouteKey === `${environmentId}:${task.workerThreadId}`;
  const open = () => {
    onOpen(task);
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
    <li data-task-id={task.id}>
      <button
        type="button"
        onClick={open}
        aria-label={`Open ${task.title}`}
        data-testid="planning-task-card"
        className={cn(
          "flex w-full min-w-0 cursor-pointer flex-col justify-center gap-0.5 rounded-md px-2 text-left outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset",
          backlog ? "py-1.5" : "h-8",
          active && "bg-sidebar-row-selected",
        )}
        {...(active ? { "data-active": true } : {})}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <TaskAttention task={task} />
          {task.priority ? <TaskPriorityStar /> : null}
          <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90">
            {task.title}
          </span>
          {task.workerThreadId !== null ? (
            <WorkerStatusDot environmentId={environmentId} workerThreadId={task.workerThreadId} />
          ) : !backlog && task.nextActor === "coordinator" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label="Handled by agent · no worker chat"
                    className="shrink-0 text-sidebar-muted-foreground"
                  />
                }
              >
                <BotIcon aria-hidden className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">Handled by agent · no worker chat</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
        {backlog ? (
          <span className="truncate text-xs leading-4 text-sidebar-muted-foreground/80">
            <BacklogActivity environmentId={environmentId} workerThreadId={task.workerThreadId} />
          </span>
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
  return <time dateTime={shell.updatedAt}>{label}</time>;
}

export function WorkerStatusDot({
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
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
  readonly task: FirstmateTask;
  readonly activeRouteKey: string | null;
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const threadId = task.workerThreadId ?? coordinatorThreadId;
  const active = task.workerThreadId !== null && activeRouteKey === `${environmentId}:${threadId}`;
  return (
    <li data-task-id={task.id}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId }}
              onClick={(event) => {
                if (
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                )
                  onOpen(task);
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
          <TaskAttention task={task} />
          {task.priority ? <TaskPriorityStar /> : null}
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          {task.workerThreadId !== null ? (
            <WorkerStatusDot environmentId={environmentId} workerThreadId={task.workerThreadId} />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right" className="max-w-72">
          <span className="block font-medium">{task.title}</span>
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
  hasStandup = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
  readonly tasks: readonly FirstmateTask[];
  readonly activeRouteKey: string | null;
  /** The Standup section above lists the agent's standup tasks, so they are not repeated here. */
  readonly hasStandup?: boolean;
}) {
  const navigate = useNavigate();
  const claimRouteReveal = useClaimSidebarRouteReveal();
  const { isMobile, setOpenMobile } = useSidebar();
  const selected = useRef<{ id: string; routeKey: string } | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  const [backlogOpen, setBacklogOpen] = useState(false);
  const backlogPanelId = useId();
  // Every way the tree opens a task passes through here before navigating.
  const rememberTask = (task: FirstmateTask) => {
    const routeKey = scopedThreadKey(
      scopeThreadRef(environmentId, task.workerThreadId ?? coordinatorThreadId),
    );
    selected.current = { id: task.id, routeKey };
    claimRouteReveal(routeKey);
  };
  useWorkSidebarShortcut((command) => {
    if (command !== "task.previous" && command !== "task.next") return false;
    const ordered = sidebarNavigationTasks(
      backlogOpen ? tasks : tasks.filter((task) => firstmateTaskStatus(task) !== "backlog"),
    );
    const currentId =
      selected.current?.routeKey === activeRouteKey
        ? selected.current.id
        : (ordered.find(
            (task) =>
              task.workerThreadId !== null &&
              `${environmentId}:${task.workerThreadId}` === activeRouteKey,
          )?.id ?? null);
    const target = adjacentSidebarTask(
      ordered,
      currentId,
      command === "task.next" ? "next" : "previous",
    );
    if (target === null) return true;
    rememberTask(target);
    if (isMobile) setOpenMobile(false);
    if (target.workerThreadId === null) {
      const ref = scopeThreadRef(environmentId, coordinatorThreadId);
      useFirstmateTaskFocusStore.getState().requestTask({
        threadKey: scopedThreadKey(ref),
        taskId: target.id,
      });
      useRightPanelStore.getState().open(ref, "firstmate");
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: target.workerThreadId ?? coordinatorThreadId },
    });
    const row = [...(tree.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])].find(
      (element) => element.dataset.taskId === target.id,
    );
    row?.scrollIntoView?.({ block: "nearest" });
    return true;
  });
  const columns = mapFirstmateBoard(tasks);
  const sections = OPEN_TASK_COLUMNS.filter((column) => columns[column].length > 0);
  if (sections.length === 0) {
    if (hasStandup) return null;
    return <p className="px-2 py-1 text-sm text-sidebar-muted-foreground/70">No open tasks</p>;
  }
  return (
    <div ref={tree} className="flex flex-col gap-3">
      {sections.map((column) => {
        const heading = (
          <>
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", COLUMN_DOT[column])}
            />
            <span className="truncate">{COLUMN_LABELS[column]}</span>
            <span className="tabular-nums">{columns[column].length}</span>
          </>
        );
        return (
          <section key={column} aria-label={COLUMN_LABELS[column]}>
            <h3 className="mb-1 flex h-6 items-center gap-1.5 pr-1.5 pl-2 text-xs font-medium text-sidebar-muted-foreground/80">
              {column === "backlog" ? (
                <button
                  type="button"
                  aria-expanded={backlogOpen}
                  aria-controls={backlogPanelId}
                  onClick={() => setBacklogOpen((open) => !open)}
                  className="flex h-full w-full items-center gap-1.5 rounded-sm text-left outline-hidden hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {heading}
                  <ChevronRightIcon
                    aria-hidden
                    className={cn("ml-auto size-3.5", backlogOpen && "rotate-90")}
                  />
                </button>
              ) : (
                heading
              )}
            </h3>
            <ul
              id={column === "backlog" ? backlogPanelId : undefined}
              hidden={column === "backlog" && !backlogOpen}
              className="flex flex-col"
            >
              {(column === "backlog" && !backlogOpen ? [] : columns[column]).map((task) =>
                column === "planning" || column === "backlog" || task.workerThreadId === null ? (
                  <PlanningCard
                    key={task.id}
                    environmentId={environmentId}
                    coordinatorThreadId={coordinatorThreadId}
                    task={task}
                    activeRouteKey={activeRouteKey}
                    onOpen={rememberTask}
                  />
                ) : (
                  <TaskRow
                    key={task.id}
                    environmentId={environmentId}
                    coordinatorThreadId={coordinatorThreadId}
                    task={task}
                    activeRouteKey={activeRouteKey}
                    onOpen={rememberTask}
                  />
                ),
              )}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
