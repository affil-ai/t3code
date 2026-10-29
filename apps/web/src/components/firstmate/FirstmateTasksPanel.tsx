/**
 * An agent's Tasks panel, a right-panel surface beside its coordinator chat.
 * Tasks stack in an attention section (Needs you), then the lifecycle sections
 * in the sidebar's order (`FIRSTMATE_SECTION_ORDER`), with Backlog and Done
 * folded, newest activity first. It is read-only:
 * the user changes tasks by talking to the chat. A card drills into the task's intent, definition of
 * done, evidence, links, and event log, with a back button to the list.
 */
import {
  type EnvironmentId,
  FIRSTMATE_AGENT_ID,
  type FirstmateTask,
  type ThreadId,
} from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAgentsHome, useAgentTasks } from "~/state/agents";
import { useFirstmateTaskFocusStore } from "./firstmateTaskFocusStore";
import { useFirstmateSnapshot } from "~/state/firstmate";
import { ScheduledSection } from "./FirstmateScheduledSection";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  FIRSTMATE_SECTION_ORDER,
  type FirstmateColumnId,
  firstmateColumnForTask,
  firstmateTaskActivityAt,
  mapFirstmateBoard,
} from "@t3tools/client-runtime/firstmate/board";
import { TaskDetail } from "./FirstmateTaskDetail";
import { TaskPriorityStar } from "./TaskPriority";
import { TaskProgressLine } from "./FirstmateTaskProgress";
import { CARD_LINK_CLASS, ExternalTaskLink, WorkerThreadLink } from "./FirstmateTaskLinks";
import { COLUMN_DOT, CoordinatorThreadContext, relativeAge } from "./firstmateTasksShared";
import {
  COLUMN_EMPTY,
  COLUMN_LABELS,
  nextActorLabel,
  taskNextStep,
  taskStatusLabel,
} from "@t3tools/client-runtime/firstmate/tasks";

function TaskCard({
  environmentId,
  task,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
  readonly onOpen: () => void;
}) {
  const closed = task.state === "done" || task.state === "dropped";
  const nextStep = taskNextStep(task);
  return (
    <li
      className={cn(
        "group/card relative rounded-lg border border-border/70 bg-card text-card-foreground shadow-xs/5 transition-colors hover:border-border",
      )}
    >
      {/* The whole card opens the detail; links inside sit above this button. */}
      <button
        type="button"
        className="absolute inset-0 cursor-pointer rounded-[inherit] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-label={`Open ${task.title}`}
        onClick={onOpen}
      />
      <div className="pointer-events-none relative px-2.5 pt-2 pb-2">
        <p
          className={cn(
            "line-clamp-2 text-sm leading-5 font-medium",
            closed && "text-muted-foreground",
          )}
        >
          {task.priority ? (
            <>
              <TaskPriorityStar />{" "}
            </>
          ) : null}
          {task.title}
        </p>
        <TaskProgressLine task={task} className="mt-0.5" />
        {nextStep !== null ? (
          <Tooltip>
            {/* Above the card's button so the full text shows; a click still opens the task. */}
            <TooltipTrigger
              render={
                <p
                  className="pointer-events-auto mt-0.5 cursor-pointer truncate text-xs leading-4 text-foreground/80"
                  onClick={onOpen}
                />
              }
            >
              {nextStep}
            </TooltipTrigger>
            <TooltipPopup>{nextStep}</TooltipPopup>
          </Tooltip>
        ) : null}
        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground/80">
          {task.workerThreadId !== null ? (
            <>
              <WorkerThreadLink
                environmentId={environmentId}
                task={task}
                className={cn(CARD_LINK_CLASS, "pointer-events-auto -ms-1 shrink-0")}
              />
              <span aria-hidden>·</span>
            </>
          ) : null}
          {nextStep !== null ? (
            <span className="shrink-0 rounded-sm bg-muted px-1 leading-4 text-muted-foreground">
              {nextActorLabel(task)}
            </span>
          ) : (
            <span className="truncate">{taskStatusLabel(task)}</span>
          )}
          <span aria-hidden>·</span>
          <span className="truncate">{COLUMN_LABELS[firstmateColumnForTask(task)]}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">
            {relativeAge(firstmateTaskActivityAt(task))}
          </span>
        </div>
        {task.links.length > 0 ? (
          <div className="pointer-events-auto -mx-1 mt-1 flex min-w-0 flex-wrap gap-x-0.5">
            {task.links.map((link) => (
              <ExternalTaskLink
                key={`${link.label}:${link.url}`}
                environmentId={environmentId}
                link={link}
                className={CARD_LINK_CLASS}
              />
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ColumnHeader({
  column,
  count,
  trailing,
}: {
  readonly column: FirstmateColumnId;
  readonly count: number;
  readonly trailing?: ReactNode;
}) {
  return (
    <>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", COLUMN_DOT[column])} />
      <h2 className="truncate text-xs font-medium text-foreground">{COLUMN_LABELS[column]}</h2>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      {trailing}
    </>
  );
}

function TaskList({
  environmentId,
  tasks,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly tasks: readonly FirstmateTask[];
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  return (
    <ul role="list" className="flex flex-col gap-1.5">
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          environmentId={environmentId}
          task={task}
          onOpen={() => onOpen(task)}
        />
      ))}
    </ul>
  );
}

function ActiveSection({
  column,
  environmentId,
  tasks,
  onOpen,
}: {
  readonly column: Exclude<FirstmateColumnId, "done">;
  readonly environmentId: EnvironmentId;
  readonly tasks: readonly FirstmateTask[];
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  return (
    <section aria-label={COLUMN_LABELS[column]} className="flex min-w-0 flex-col">
      <header className="flex h-7 shrink-0 items-center gap-1.5 px-1.5">
        <ColumnHeader column={column} count={tasks.length} />
      </header>
      {tasks.length === 0 ? (
        <p className="px-1.5 pt-0.5 pb-1 text-xs text-muted-foreground/70">
          {COLUMN_EMPTY[column]}
        </p>
      ) : (
        <TaskList environmentId={environmentId} tasks={tasks} onOpen={onOpen} />
      )}
    </section>
  );
}

/** Parked and closed work stays folded until the user opens it. */
function FoldedSection({
  column,
  environmentId,
  tasks,
  onOpen,
}: {
  readonly column: "backlog" | "done";
  readonly environmentId: EnvironmentId;
  readonly tasks: readonly FirstmateTask[];
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<section aria-label={COLUMN_LABELS[column]} />}
      className="flex min-w-0 flex-col"
    >
      <CollapsibleTrigger
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        disabled={tasks.length === 0}
      >
        <ColumnHeader
          column={column}
          count={tasks.length}
          trailing={
            tasks.length > 0 ? (
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "ml-auto size-3.5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                  open && "rotate-90",
                )}
              />
            ) : null
          }
        />
      </CollapsibleTrigger>
      {tasks.length === 0 ? (
        <p className="px-1.5 pt-0.5 pb-1 text-xs text-muted-foreground/70">
          {column === "backlog" ? "Nothing in backlog" : "Nothing closed yet"}
        </p>
      ) : null}
      <CollapsiblePanel animate={false}>
        <TaskList environmentId={environmentId} tasks={tasks} onOpen={onOpen} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

function TaskSections({
  environmentId,
  threadId,
  tasks,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  /** The coordinator chat, whose automations the last section lists. */
  readonly threadId: ThreadId;
  readonly tasks: readonly FirstmateTask[];
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  const columns = mapFirstmateBoard(tasks);
  return (
    <ScrollArea className="min-h-0 flex-1" scrollFade>
      <div className="flex flex-col gap-3 px-2 pt-1 pb-4">
        <ActiveSection
          column="needs-you"
          environmentId={environmentId}
          tasks={columns["needs-you"]}
          onOpen={onOpen}
        />
        <p className="px-1.5 text-xs text-muted-foreground">All work · grouped by status</p>
        {FIRSTMATE_SECTION_ORDER.filter(
          // Most boards have no standup task; an empty Standup section is only noise.
          (column) => column !== "standup" || columns.standup.length > 0,
        ).map((column) =>
          column === "backlog" || column === "done" ? (
            <FoldedSection
              key={column}
              column={column}
              environmentId={environmentId}
              tasks={columns[column]}
              onOpen={onOpen}
            />
          ) : (
            <ActiveSection
              key={column}
              column={column}
              environmentId={environmentId}
              tasks={columns[column]}
              onOpen={onOpen}
            />
          ),
        )}
        {/* Automations are triggers, not board work: rule them off. */}
        <div role="separator" className="-mx-2 my-1 border-t border-border" />
        <ScheduledSection environmentId={environmentId} threadId={threadId} />
      </div>
    </ScrollArea>
  );
}

/** The panel's top row: "Tasks", or a way back from a task. */
function PanelHeader({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-10 min-w-0 shrink-0 items-center gap-1.5 border-b border-border/60 ps-2 pe-3">
      {children}
    </div>
  );
}

function PanelMessage({ title, children }: { readonly title: string; readonly children: string }) {
  return (
    <Empty size="compact" className="min-h-0 flex-1">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/**
 * The right-panel surface for `{ kind: "firstmate" }`: the board of whichever
 * agent's coordinator chat is open, Firstmate's or another agent's. Beside any
 * other chat it says so.
 */
export function FirstmateTasksPanel({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  // Ages on the cards stay current without a new snapshot.
  useRelativeTimeTick(60_000);
  const agentsHome = useAgentsHome();
  const agent =
    agentsHome?.environmentId === environmentId
      ? (agentsHome.agents.find((candidate) => candidate.coordinatorThreadId === threadId) ?? null)
      : null;
  // Firstmate's own stream is the fallback for a server that predates agents.
  const firstmateQuery = useFirstmateSnapshot(environmentId);
  const agentQuery = useAgentTasks(
    environmentId,
    agent === null || agent.id === FIRSTMATE_AGENT_ID ? null : agent.id,
  );
  const snapshotQuery =
    agent !== null && agent.id !== FIRSTMATE_AGENT_ID ? agentQuery : firstmateQuery;
  const snapshot = snapshotQuery.data;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // A sidebar card can ask for one task's detail as it opens this panel.
  const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const focusRequest = useFirstmateTaskFocusStore((state) => state.request);
  useEffect(() => {
    if (focusRequest === null || focusRequest.threadKey !== threadKey) return;
    const taskId = useFirstmateTaskFocusStore.getState().take(threadKey);
    if (taskId !== null) setSelectedTaskId(taskId);
  }, [focusRequest, threadKey]);
  if (snapshot === null) {
    return snapshotQuery.error ? (
      <PanelMessage title="Tasks aren't available">
        This server doesn't run agents, or it couldn't be reached.
      </PanelMessage>
    ) : (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-4" />
      </div>
    );
  }
  if (snapshot.coordinatorThreadId !== threadId) {
    return (
      <PanelMessage title="Not this chat's tasks">
        {`${snapshot.name}'s tasks show beside its own chat. Open ${snapshot.name} from the sidebar.`}
      </PanelMessage>
    );
  }
  // The detail follows the live snapshot, so an open task updates in place;
  // a task that leaves the snapshot returns the panel to the list.
  const selectedTask =
    selectedTaskId === null
      ? null
      : (snapshot.tasks.find((task) => task.id === selectedTaskId) ?? null);
  return (
    <CoordinatorThreadContext value={threadId}>
      <div className="@container/tasks flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {selectedTask ? (
          <>
            <PanelHeader>
              <Button
                size="sm"
                variant="ghost"
                className="-ms-1 min-w-0"
                onClick={() => setSelectedTaskId(null)}
              >
                <ArrowLeftIcon />
                Tasks
              </Button>
            </PanelHeader>
            <TaskDetail environmentId={environmentId} task={selectedTask} />
          </>
        ) : (
          <>
            <TaskSections
              environmentId={environmentId}
              threadId={threadId}
              tasks={snapshot.tasks}
              onOpen={(task) => setSelectedTaskId(task.id)}
            />
          </>
        )}
      </div>
    </CoordinatorThreadContext>
  );
}

/** Re-renders on an interval so relative ages stay current without a new snapshot. */
function useRelativeTimeTick(intervalMs: number) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}
