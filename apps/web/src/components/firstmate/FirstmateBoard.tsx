/**
 * The Firstmate board: every tracked task in one of four columns, newest
 * activity first. It is read-only; the user changes tasks by talking to the
 * coordinator chat beside it. A card opens a side sheet with the task's
 * intent, definition of done, evidence, links, and event log.
 */
import type { EnvironmentId, FirstmateTask, FirstmateTaskEvent } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, LinkIcon, MessageSquareTextIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "~/lib/utils";
import { useFirstmateTask } from "~/state/firstmate";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Skeleton } from "../ui/skeleton";
import {
  type FirstmateColumnId,
  firstmateColumnForTask,
  firstmateTaskActivityAt,
  isPullRequestUrl,
  mapFirstmateBoard,
} from "./firstmateBoard.logic";

const COLUMN_LABELS: Record<FirstmateColumnId, string> = {
  "needs-you": "Needs you",
  "in-progress": "In progress",
  waiting: "Waiting",
  done: "Done",
};

const COLUMN_EMPTY: Record<Exclude<FirstmateColumnId, "done">, string> = {
  "needs-you": "Nothing needs you",
  "in-progress": "Nothing in progress",
  waiting: "Nothing waiting",
};

/** A small dot per column; it is the board's only color. */
const COLUMN_DOT: Record<FirstmateColumnId, string> = {
  "needs-you": "bg-warning",
  "in-progress": "bg-info",
  waiting: "bg-muted-foreground/60",
  done: "bg-muted-foreground/30",
};

/** Who acts next, in the reader's terms. */
const NEXT_ACTOR_LABELS: Record<FirstmateTask["nextActor"], string> = {
  user: "You",
  worker: "Worker",
  coordinator: "Firstmate",
  external: "Someone else",
};

const CLOSED_STATE_LABELS: Partial<Record<FirstmateTask["state"], string>> = {
  done: "Done",
  dropped: "Dropped",
};

const EVENT_ACTOR_LABELS: Record<FirstmateTaskEvent["actor"], string> = {
  coordinator: "Firstmate",
  user: "You",
  system: "System",
};

function relativeAge(value: string): string {
  return formatRelativeTimeLabel(value) || "just now";
}

/** What the card's meta line says about who has the ball. */
function taskStatusLabel(task: FirstmateTask): string {
  const closed = CLOSED_STATE_LABELS[task.state];
  if (closed) return closed;
  return `Next: ${NEXT_ACTOR_LABELS[task.nextActor]}`;
}

function stopPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

function WorkerThreadLink({
  environmentId,
  task,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
  readonly className?: string;
}) {
  if (task.workerThreadId === null) return null;
  return (
    <Link
      className={className}
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: task.workerThreadId }}
      onClick={stopPropagation}
    >
      <MessageSquareTextIcon className="size-3 shrink-0" />
      <span className="truncate">Worker chat</span>
    </Link>
  );
}

function ExternalTaskLink({
  link,
  className,
}: {
  readonly link: FirstmateTask["links"][number];
  readonly className?: string;
}) {
  const Icon = isPullRequestUrl(link.url) ? PullRequestGlyph.pullRequest : LinkIcon;
  return (
    <a
      className={className}
      href={link.url}
      target="_blank"
      rel="noreferrer"
      onClick={stopPropagation}
    >
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{link.label}</span>
    </a>
  );
}

const CARD_LINK_CLASS =
  "inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function TaskCard({
  environmentId,
  task,
  selected,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
  readonly selected: boolean;
  readonly onOpen: () => void;
}) {
  const closed = task.state === "done" || task.state === "dropped";
  const hasLinks = task.workerThreadId !== null || task.links.length > 0;
  return (
    <li
      className={cn(
        "group/card relative rounded-lg border bg-card text-card-foreground shadow-xs/5 transition-colors",
        selected ? "border-ring/60" : "border-border/70 hover:border-border",
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
        {task.note.trim().length > 0 ? (
          <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-muted-foreground">{task.note}</p>
        ) : null}
        <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground/80">
          <span className="truncate">{taskStatusLabel(task)}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0 tabular-nums">
            {relativeAge(firstmateTaskActivityAt(task))}
          </span>
        </p>
        {hasLinks ? (
          <div className="pointer-events-auto -mx-1 mt-1 flex min-w-0 flex-wrap gap-x-0.5">
            <WorkerThreadLink
              environmentId={environmentId}
              task={task}
              className={CARD_LINK_CLASS}
            />
            {task.links.map((link) => (
              <ExternalTaskLink
                key={`${link.label}:${link.url}`}
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
  selectedTaskId,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly tasks: readonly FirstmateTask[];
  readonly selectedTaskId: string | null;
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  return (
    <ul className="flex flex-col gap-1.5">
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          environmentId={environmentId}
          task={task}
          selected={task.id === selectedTaskId}
          onOpen={() => onOpen(task)}
        />
      ))}
    </ul>
  );
}

const COLUMN_CLASS =
  "flex min-w-0 flex-col @4xl/board:min-h-0 @4xl/board:rounded-xl @4xl/board:bg-muted/40 @4xl/board:p-1.5 dark:@4xl/board:bg-muted/24";

function ActiveColumn({
  column,
  environmentId,
  tasks,
  selectedTaskId,
  onOpen,
}: {
  readonly column: Exclude<FirstmateColumnId, "done">;
  readonly environmentId: EnvironmentId;
  readonly tasks: readonly FirstmateTask[];
  readonly selectedTaskId: string | null;
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  return (
    <section aria-label={COLUMN_LABELS[column]} className={COLUMN_CLASS}>
      <header className="flex h-7 shrink-0 items-center gap-1.5 px-1.5">
        <ColumnHeader column={column} count={tasks.length} />
      </header>
      <div className="@4xl/board:min-h-0 @4xl/board:flex-1 @4xl/board:overflow-y-auto">
        {tasks.length === 0 ? (
          <p className="px-1.5 pt-1 pb-2 text-xs text-muted-foreground/70">
            {COLUMN_EMPTY[column]}
          </p>
        ) : (
          <TaskList
            environmentId={environmentId}
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onOpen={onOpen}
          />
        )}
      </div>
    </section>
  );
}

/** Closed tasks stay folded away unless the user opens them. */
function DoneColumn({
  environmentId,
  tasks,
  selectedTaskId,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly tasks: readonly FirstmateTask[];
  readonly selectedTaskId: string | null;
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<section aria-label={COLUMN_LABELS.done} />}
      className={COLUMN_CLASS}
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
        <p className="px-1.5 pt-1 pb-2 text-xs text-muted-foreground/70">Nothing closed yet</p>
      ) : !open ? (
        <p className="px-1.5 pt-1 pb-2 text-xs text-muted-foreground/70">
          {tasks.length === 1 ? "1 closed task" : `Latest ${tasks.length} closed tasks`}
        </p>
      ) : null}
      <CollapsiblePanel
        animate={false}
        className="@4xl/board:min-h-0 @4xl/board:flex-1 @4xl/board:overflow-y-auto"
      >
        <TaskList
          environmentId={environmentId}
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          onOpen={onOpen}
        />
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function FirstmateBoard({
  environmentId,
  tasks,
}: {
  readonly environmentId: EnvironmentId;
  readonly tasks: readonly FirstmateTask[];
}) {
  // Ages on the cards stay current without a new snapshot.
  useRelativeTimeTick(60_000);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const columns = mapFirstmateBoard(tasks);
  // The sheet follows the live snapshot, so an open task updates in place.
  const selectedTask =
    selectedTaskId === null ? null : (tasks.find((task) => task.id === selectedTaskId) ?? null);
  const open = (task: FirstmateTask) => setSelectedTaskId(task.id);
  return (
    // Wide boards show four side-by-side columns that scroll on their own;
    // narrow ones stack the columns in one scrolling list.
    <div className="@container/board flex min-h-0 min-w-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1" scrollFade>
        <div className="flex flex-col gap-4 px-3 pt-1 pb-4 @4xl/board:grid @4xl/board:h-full @4xl/board:grid-cols-4 @4xl/board:gap-2 @4xl/board:pb-3">
          {(["needs-you", "in-progress", "waiting"] as const).map((column) => (
            <ActiveColumn
              key={column}
              column={column}
              environmentId={environmentId}
              tasks={columns[column]}
              selectedTaskId={selectedTaskId}
              onOpen={open}
            />
          ))}
          <DoneColumn
            environmentId={environmentId}
            tasks={columns.done}
            selectedTaskId={selectedTaskId}
            onOpen={open}
          />
        </div>
      </ScrollArea>
      <Sheet
        open={selectedTask !== null}
        onOpenChange={(next) => {
          if (!next) setSelectedTaskId(null);
        }}
      >
        {selectedTask ? (
          <TaskDetailSheet environmentId={environmentId} task={selectedTask} />
        ) : null}
      </Sheet>
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function DetailText({ children }: { readonly children: string }) {
  return <p className="text-sm leading-5 whitespace-pre-wrap text-foreground">{children}</p>;
}

const DETAIL_LINK_CLASS =
  "flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>svg]:size-3.5 [&>svg]:text-muted-foreground";

function TaskDetailSheet({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
}) {
  const detailQuery = useFirstmateTask(environmentId, task.id);
  // The snapshot is newer than a loaded detail whenever the task changes, so
  // fields come from the snapshot and only the events come from the query.
  const events = detailQuery.data?.events ?? null;
  const column = firstmateColumnForTask(task);
  const hasLinks = task.workerThreadId !== null || task.links.length > 0;
  return (
    <SheetPopup side="right" className="sm:max-w-md">
      <SheetHeader>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className={cn("size-1.5 rounded-full", COLUMN_DOT[column])} />
          <span>{COLUMN_LABELS[column]}</span>
          <span aria-hidden>·</span>
          <span>{taskStatusLabel(task)}</span>
        </div>
        <SheetTitle>{task.title}</SheetTitle>
        {task.note.trim().length > 0 ? <SheetDescription>{task.note}</SheetDescription> : null}
      </SheetHeader>
      <ScrollArea className="min-h-0 flex-1" scrollFade>
        <div className="space-y-5 px-6 pb-6">
          <DetailSection title="What you asked">
            <DetailText>{task.intent}</DetailText>
          </DetailSection>
          <DetailSection title="Done when">
            <DetailText>{task.definitionOfDone}</DetailText>
          </DetailSection>
          {task.closeEvidence ? (
            <DetailSection title={task.state === "dropped" ? "Why it was dropped" : "Evidence"}>
              <DetailText>{task.closeEvidence}</DetailText>
            </DetailSection>
          ) : null}
          {hasLinks ? (
            <DetailSection title="Links">
              <div className="-mx-2 flex flex-col">
                <WorkerThreadLink
                  environmentId={environmentId}
                  task={task}
                  className={DETAIL_LINK_CLASS}
                />
                {task.links.map((link) => (
                  <ExternalTaskLink
                    key={`${link.label}:${link.url}`}
                    link={link}
                    className={DETAIL_LINK_CLASS}
                  />
                ))}
              </div>
            </DetailSection>
          ) : null}
          <DetailSection title="History">
            {detailQuery.error && events === null ? (
              <p className="text-sm text-destructive-foreground">Could not load the history.</p>
            ) : events === null ? (
              <div className="space-y-2 pt-1" aria-busy>
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No history yet.</p>
            ) : (
              <ol className="relative mt-1 space-y-3 border-s border-border/70 ps-3.5">
                {events.toReversed().map((event) => (
                  <li key={event.id} className="relative">
                    <span
                      aria-hidden
                      className="absolute top-1.5 -left-[1.1875rem] size-1.5 rounded-full bg-muted-foreground/50 ring-2 ring-popover"
                    />
                    <p className="text-sm leading-5 text-foreground">{event.summary}</p>
                    <p className="text-2xs text-muted-foreground">
                      {EVENT_ACTOR_LABELS[event.actor]} · {relativeAge(event.createdAt)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </DetailSection>
          <p className="text-2xs text-muted-foreground/70">
            Opened {relativeAge(task.createdAt)}
            {task.closedAt ? ` · Closed ${relativeAge(task.closedAt)}` : null}
          </p>
        </div>
      </ScrollArea>
    </SheetPopup>
  );
}
