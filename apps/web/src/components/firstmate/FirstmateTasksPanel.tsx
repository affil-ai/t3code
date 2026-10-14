/**
 * An agent's Tasks panel, a right-panel surface beside its coordinator chat.
 * Tasks stack in sections (Needs you, Ready for deployment, In progress,
 * In review, and a folded Done), newest activity first. It is read-only: the user changes tasks by
 * talking to the chat. A card drills into the task's intent, definition of
 * done, evidence, links, and event log, with a back button to the list.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type AgentProfile,
  type EnvironmentId,
  FIRSTMATE_AGENT_ID,
  type FirstmateSnapshot,
  type FirstmateTask,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  EllipsisIcon,
  ListChecksIcon,
  PencilIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { useAgentsHome, useAgentTasks } from "~/state/agents";
import { firstmateEnvironment, useFirstmateSnapshot } from "~/state/firstmate";
import { AgentDialog } from "../agents/AgentDialog";
import { ScheduledSection } from "./FirstmateScheduledSection";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { FirstmateAppearanceDialog } from "./FirstmateAppearanceDialog";
import { useFirstmateCommands } from "./firstmateCommands";
import {
  type FirstmateColumnId,
  countFirstmateNeedsYou,
  firstmateTaskActivityAt,
  mapFirstmateBoard,
} from "./firstmateBoard.logic";
import { TaskDetail } from "./FirstmateTaskDetail";
import { CARD_LINK_CLASS, ExternalTaskLink, WorkerThreadLink } from "./FirstmateTaskLinks";
import {
  COLUMN_DOT,
  COLUMN_EMPTY,
  COLUMN_LABELS,
  CoordinatorThreadContext,
  relativeAge,
  taskStatusLabel,
} from "./firstmateTasksShared";

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
          {task.title}
        </p>
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
          <span className="truncate">{taskStatusLabel(task)}</span>
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
    <ul className="flex flex-col gap-1.5">
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

/** Closed tasks stay folded away unless the user opens them. */
function DoneSection({
  environmentId,
  tasks,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly tasks: readonly FirstmateTask[];
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<section aria-label={COLUMN_LABELS.done} />}
      className="flex min-w-0 flex-col"
    >
      <CollapsibleTrigger
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-accent/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        disabled={tasks.length === 0}
      >
        <ColumnHeader
          column="done"
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
        <p className="px-1.5 pt-0.5 pb-1 text-xs text-muted-foreground/70">Nothing closed yet</p>
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
  /** The coordinator chat, whose scheduled tasks the last section lists. */
  readonly threadId: ThreadId;
  readonly tasks: readonly FirstmateTask[];
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  const columns = mapFirstmateBoard(tasks);
  return (
    <ScrollArea className="min-h-0 flex-1" scrollFade>
      <div className="flex flex-col gap-3 px-2 pt-1 pb-4">
        {(["needs-you", "ready", "in-progress", "in-review"] as const).map((column) => (
          <ActiveSection
            key={column}
            column={column}
            environmentId={environmentId}
            tasks={columns[column]}
            onOpen={onOpen}
          />
        ))}
        <DoneSection environmentId={environmentId} tasks={columns.done} onOpen={onOpen} />
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

/**
 * Rename, change the icon, or stop using the coordinator chat. For an agent
 * other than Firstmate the first item opens the agent editor, which also
 * takes the role and color.
 */
function TasksMenu({
  environmentId,
  snapshot,
  agent,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: FirstmateSnapshot;
  readonly agent: AgentProfile | null;
}) {
  const canOperate = useAtomValue(
    firstmateEnvironment.setCoordinator.permissionAtom(environmentId),
  );
  const { pending, setCoordinator, run } = useFirstmateCommands();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const isFirstmate = agent === null || agent.id === FIRSTMATE_AGENT_ID;
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost-muted"
              className="shrink-0"
              aria-label={`${snapshot.name} options`}
              disabled={pending !== null}
            />
          }
        >
          {pending === "setCoordinator" ? <Spinner className="size-3.5" /> : <EllipsisIcon />}
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem disabled={!canOperate} onClick={() => setAppearanceOpen(true)}>
            <PencilIcon />
            {isFirstmate ? "Name and icon…" : "Name, role, and icon…"}
          </MenuItem>
          {isFirstmate ? (
            <MenuItem
              disabled={!canOperate}
              onClick={() =>
                void run(
                  "setCoordinator",
                  () => setCoordinator({ environmentId, input: { threadId: null } }),
                  `Could not stop ${snapshot.name}`,
                )
              }
            >
              <CircleSlashIcon />
              Stop using this chat
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      {isFirstmate ? (
        <FirstmateAppearanceDialog
          environmentId={environmentId}
          name={snapshot.name}
          icon={snapshot.icon}
          open={appearanceOpen}
          onOpenChange={setAppearanceOpen}
        />
      ) : (
        <AgentDialog
          environmentId={environmentId}
          agent={agent}
          open={appearanceOpen}
          onOpenChange={setAppearanceOpen}
        />
      )}
    </>
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
  const needsYou = countFirstmateNeedsYou(snapshot.tasks);
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
            <PanelHeader>
              <ListChecksIcon className="ms-1 size-4 shrink-0 text-muted-foreground" />
              <h2 className="min-w-0 flex-1 truncate text-sm font-medium">Tasks</h2>
              {needsYou > 0 ? (
                <Badge variant="warning" size="sm" aria-label={`${needsYou} need you`}>
                  {needsYou}
                </Badge>
              ) : null}
              <TasksMenu environmentId={environmentId} snapshot={snapshot} agent={agent} />
            </PanelHeader>
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
