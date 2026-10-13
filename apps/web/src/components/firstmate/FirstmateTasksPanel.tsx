/**
 * Firstmate's Tasks panel, a right-panel surface beside the coordinator chat.
 * Tasks stack in sections (Needs you, In progress, In review, and a folded
 * Done), newest activity first. It is read-only: the user changes tasks by
 * talking to the chat. A card drills into the task's intent, definition of
 * done, evidence, links, and event log, with a back button to the list.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  FirstmateSnapshot,
  FirstmateTask,
  FirstmateTaskEvent,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  EllipsisIcon,
  ListChecksIcon,
  LinkIcon,
  MessageSquareTextIcon,
  PencilIcon,
} from "lucide-react";
import { createContext, type ReactNode, use, useState } from "react";

import { cn } from "~/lib/utils";
import { usePullRequestPreviewTarget } from "~/lib/openPullRequestLink";
import { firstmateEnvironment, useFirstmateSnapshot, useFirstmateTask } from "~/state/firstmate";
import { linkedPullRequestDetailAtom } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { SlackIcon } from "../Icons";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { FirstmateAppearanceDialog } from "./FirstmateAppearanceDialog";
import { FirstmateArtifactList, FirstmateArtifactStrip } from "./FirstmateTaskArtifacts";
import { useFirstmateCommands } from "./firstmateCommands";
import {
  type FirstmateColumnId,
  firstmateColumnForTask,
  countFirstmateNeedsYou,
  firstmateTaskActivityAt,
  isPullRequestUrl,
  isSlackUrl,
  mapFirstmateBoard,
} from "./firstmateBoard.logic";

/** The coordinator chat beside the panel; artifact images are signed against it. */
const CoordinatorThreadContext = createContext<ThreadId | null>(null);

const COLUMN_LABELS: Record<FirstmateColumnId, string> = {
  "needs-you": "Needs you",
  "in-progress": "In progress",
  "in-review": "In review",
  done: "Done",
};

const COLUMN_EMPTY: Record<Exclude<FirstmateColumnId, "done">, string> = {
  "needs-you": "Nothing needs you",
  "in-progress": "Nothing in progress",
  "in-review": "Nothing in review",
};

/** A small dot per column; it is the board's only color. */
const COLUMN_DOT: Record<FirstmateColumnId, string> = {
  "needs-you": "bg-warning",
  "in-progress": "bg-info",
  "in-review": "bg-muted-foreground/60",
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
      <span className="truncate">Chat</span>
    </Link>
  );
}

/**
 * A pull request link's icon, drawn like the sidebar's: the state's glyph in
 * its color (open, draft, merged, closed). Until the state loads, or when no
 * project here can read the repository, it is the plain open glyph.
 */
function PullRequestLinkIcon({
  environmentId,
  url,
}: {
  readonly environmentId: EnvironmentId;
  readonly url: string;
}) {
  const target = usePullRequestPreviewTarget(environmentId, url);
  const summary = useEnvironmentQuery(
    target === null ? null : linkedPullRequestDetailAtom(target),
  ).data;
  if (!summary) return <PullRequestGlyph.pullRequest className="size-3 shrink-0" />;
  const state = resolvePullRequestState({
    state: summary.state,
    isDraft: summary.isDraft === true,
  });
  return (
    <state.Icon
      data-tone
      className={cn("size-3 shrink-0", state.toneClassName)}
      aria-label={`Pull request ${state.label.toLowerCase()}`}
    />
  );
}

function ExternalTaskLink({
  environmentId,
  link,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: FirstmateTask["links"][number];
  readonly className?: string;
}) {
  return (
    <a
      className={className}
      href={link.url}
      target="_blank"
      rel="noreferrer"
      onClick={stopPropagation}
    >
      {isPullRequestUrl(link.url) ? (
        <PullRequestLinkIcon environmentId={environmentId} url={link.url} />
      ) : isSlackUrl(link.url) ? (
        <SlackIcon className="size-3 shrink-0" />
      ) : (
        <LinkIcon className="size-3 shrink-0" />
      )}
      <span className="truncate">{link.label}</span>
    </a>
  );
}

const CARD_LINK_CLASS =
  "inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

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
  const coordinatorThreadId = use(CoordinatorThreadContext);
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
        {coordinatorThreadId !== null && (task.artifacts?.length ?? 0) > 0 ? (
          <FirstmateArtifactStrip
            environmentId={environmentId}
            threadId={coordinatorThreadId}
            artifacts={task.artifacts ?? []}
          />
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
  tasks,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly tasks: readonly FirstmateTask[];
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  const columns = mapFirstmateBoard(tasks);
  return (
    <ScrollArea className="min-h-0 flex-1" scrollFade>
      <div className="flex flex-col gap-3 px-2 pt-1 pb-4">
        {(["needs-you", "in-progress", "in-review"] as const).map((column) => (
          <ActiveSection
            key={column}
            column={column}
            environmentId={environmentId}
            tasks={columns[column]}
            onOpen={onOpen}
          />
        ))}
        <DoneSection environmentId={environmentId} tasks={columns.done} onOpen={onOpen} />
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

/** Rename, change the icon, or stop using the coordinator chat. */
function TasksMenu({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: FirstmateSnapshot;
}) {
  const canOperate = useAtomValue(
    firstmateEnvironment.setCoordinator.permissionAtom(environmentId),
  );
  const { pending, setCoordinator, run } = useFirstmateCommands();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
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
            Name and icon…
          </MenuItem>
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
        </MenuPopup>
      </Menu>
      <FirstmateAppearanceDialog
        environmentId={environmentId}
        name={snapshot.name}
        icon={snapshot.icon}
        open={appearanceOpen}
        onOpenChange={setAppearanceOpen}
      />
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
 * The right-panel surface for `{ kind: "firstmate" }`. It shows tasks only
 * beside the current coordinator chat; anywhere else it says so.
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
  const snapshotQuery = useFirstmateSnapshot(environmentId);
  const snapshot = snapshotQuery.data;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  if (snapshot === null) {
    return snapshotQuery.error ? (
      <PanelMessage title="Tasks aren't available">
        This server doesn't run Firstmate, or it couldn't be reached.
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
              <TasksMenu environmentId={environmentId} snapshot={snapshot} />
            </PanelHeader>
            <TaskSections
              environmentId={environmentId}
              tasks={snapshot.tasks}
              onOpen={(task) => setSelectedTaskId(task.id)}
            />
          </>
        )}
      </div>
    </CoordinatorThreadContext>
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
  "flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>svg]:size-3.5 [&>svg:not([data-tone])]:text-muted-foreground";

function TaskDetail({
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
  const coordinatorThreadId = use(CoordinatorThreadContext);
  return (
    <ScrollArea className="min-h-0 flex-1" scrollFade>
      <div className="space-y-5 px-4 pt-3 pb-6">
        <header className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className={cn("size-1.5 rounded-full", COLUMN_DOT[column])} />
            <span>{COLUMN_LABELS[column]}</span>
            <span aria-hidden>·</span>
            <span>{taskStatusLabel(task)}</span>
          </div>
          <h3 className="text-base leading-6 font-semibold text-foreground">{task.title}</h3>
        </header>
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
        {coordinatorThreadId !== null && (task.artifacts?.length ?? 0) > 0 ? (
          <DetailSection title="Review">
            <FirstmateArtifactList
              environmentId={environmentId}
              threadId={coordinatorThreadId}
              artifacts={task.artifacts ?? []}
            />
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
                  environmentId={environmentId}
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
                    className="absolute top-1.5 -left-[1.1875rem] size-1.5 rounded-full bg-muted-foreground/50 ring-2 ring-background"
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
  );
}
