/**
 * An agent's open tasks in the sidebar, in the Tasks panel's sections
 * (Needs you, Ready for deployment, In progress, In review). A task with a
 * worker opens the worker's chat, with a dot for what the worker is doing; a
 * task without one opens the agent's own chat. Closed tasks stay in the panel.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FirstmateTask, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import {
  FIRSTMATE_COLUMN_IDS,
  type FirstmateColumnId,
  mapFirstmateBoard,
} from "../firstmate/firstmateBoard.logic";
import { COLUMN_DOT, COLUMN_LABELS, taskNextStep } from "../firstmate/firstmateTasksShared";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const OPEN_COLUMNS = FIRSTMATE_COLUMN_IDS.filter(
  (column): column is Exclude<FirstmateColumnId, "done"> => column !== "done",
);

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
              className={cn(
                "flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-2 pl-5 text-xs text-sidebar-foreground/80 outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset",
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
    return (
      <p className="pt-0.5 pb-1.5 pl-14 text-xs text-sidebar-muted-foreground/70">No open tasks</p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {sections.map((column) => (
        <section key={column} aria-label={COLUMN_LABELS[column]}>
          <h3 className="flex h-6 items-center gap-1.5 px-2 text-2xs font-medium text-sidebar-muted-foreground/80">
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", COLUMN_DOT[column])}
            />
            <span className="truncate">{COLUMN_LABELS[column]}</span>
            <span className="tabular-nums">{columns[column].length}</span>
          </h3>
          <ul className="flex flex-col">
            {columns[column].map((task) => (
              <TaskRow
                key={task.id}
                environmentId={environmentId}
                coordinatorThreadId={coordinatorThreadId}
                task={task}
                activeRouteKey={activeRouteKey}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
