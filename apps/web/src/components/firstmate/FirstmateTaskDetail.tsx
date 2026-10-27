/**
 * One task's detail in the Tasks panel. It leads with what happens next (and
 * whether that is on the user), then the done-when criteria, artifacts and
 * links, the original request clamped, and recent history.
 *
 * @module FirstmateTaskDetail
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FirstmateTask, ThreadId } from "@t3tools/contracts";
import { type ReactNode, use, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { useFirstmateTask } from "~/state/firstmate";
import { ExpandableText } from "../settings/ExpandableText";
import { Button, InlineButton } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { firstmateColumnForTask } from "./firstmateBoard.logic";
import { FirstmateArtifactList } from "./FirstmateTaskArtifacts";
import { TaskPriorityToggle } from "./TaskPriority";
import { TaskProgressLine } from "./FirstmateTaskProgress";
import { ExternalTaskLink, WorkerThreadLink } from "./FirstmateTaskLinks";
import {
  COLUMN_DOT,
  COLUMN_LABELS,
  CoordinatorThreadContext,
  doneCriteria,
  EVENT_ACTOR_LABELS,
  nextActorLabel,
  readableTaskEvents,
  relativeAge,
  taskNextStep,
  taskStatusLabel,
} from "./firstmateTasksShared";

function DetailSection({
  title,
  trailing,
  children,
}: {
  readonly title: string;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {trailing}
      </div>
      {children}
    </section>
  );
}

const standupDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** "Started Oct 27, 2026 · Finished Oct 28, 2026"; open standup tasks have no finish yet. */
function standupDatesLabel(standup: NonNullable<FirstmateTask["standup"]>): string {
  const started = `Started ${standupDate(standup.startedAt)}`;
  return standup.finishedAt === null
    ? started
    : `${started} · Finished ${standupDate(standup.finishedAt)}`;
}

function DetailText({ children }: { readonly children: string }) {
  return <p className="text-sm leading-5 whitespace-pre-wrap text-foreground">{children}</p>;
}

const DETAIL_LINK_CLASS =
  "flex h-8 min-w-0 items-center gap-2 rounded-md border border-border/70 px-2.5 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>svg]:size-3.5 [&>svg:not([data-tone])]:text-muted-foreground";

const CRITERIA_PREVIEW = 5;
const HISTORY_PREVIEW = 3;

/** Toggles a list between its first few rows and all of them. */
function ShowAllToggle({
  total,
  preview,
  expanded,
  onToggle,
}: {
  readonly total: number;
  readonly preview: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  if (total <= preview) return null;
  return (
    <InlineButton tone="muted" aria-expanded={expanded} onClick={onToggle}>
      {expanded ? "Show less" : `Show all ${total}`}
    </InlineButton>
  );
}

/**
 * Puts an approval of the next step in the coordinator's composer for the user
 * to read and send. A draft already there is kept, with the approval after it.
 */
function draftApproval(environmentId: EnvironmentId, threadId: ThreadId, nextStep: string) {
  const target = scopeThreadRef(environmentId, threadId);
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(target)?.prompt.trimEnd() ?? "";
  const approval = `Approved: ${nextStep}`;
  store.setPrompt(target, existing.length > 0 ? `${existing}\n\n${approval}` : approval);
  toastManager.add({
    type: "info",
    title: "Approval drafted",
    description: "It is in Firstmate's composer. Send it to continue.",
  });
}

/** What happens next. When it is on the user, it stands out and offers an approval. */
function NextStepCard({
  environmentId,
  task,
  nextStep,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
  readonly nextStep: string;
}) {
  const coordinatorThreadId = use(CoordinatorThreadContext);
  const onUser = task.nextActor === "user";
  return (
    <section
      className={cn(
        "rounded-lg border px-3 py-2.5",
        onUser ? "border-warning/40 bg-warning/8" : "border-border/70 bg-muted/30",
      )}
    >
      <p
        className={cn(
          "text-2xs font-semibold tracking-wide uppercase",
          onUser ? "text-warning" : "text-muted-foreground",
        )}
      >
        {onUser ? "Your move" : `Next · ${nextActorLabel(task)}`}
      </p>
      <p className="mt-0.5 text-sm leading-5 font-medium text-foreground">{nextStep}</p>
      {onUser && coordinatorThreadId !== null ? (
        <Button
          size="xs"
          className="mt-2.5"
          onClick={() => draftApproval(environmentId, coordinatorThreadId, nextStep)}
        >
          Draft approval
        </Button>
      ) : null}
    </section>
  );
}

function DoneCriteria({ text }: { readonly text: string }) {
  const criteria = doneCriteria(text);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? criteria : criteria.slice(0, CRITERIA_PREVIEW);
  return (
    <DetailSection
      title="Done when"
      trailing={
        <ShowAllToggle
          total={criteria.length}
          preview={CRITERIA_PREVIEW}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      }
    >
      <ul className="space-y-1">
        {shown.map((criterion, index) => (
          <li
            key={`${index}:${criterion}`}
            className="flex gap-2 text-sm leading-5 text-foreground"
          >
            <span
              aria-hidden
              className="mt-[0.4375rem] size-1.5 shrink-0 rounded-full border border-muted-foreground/60"
            />
            <span>{criterion}</span>
          </li>
        ))}
      </ul>
    </DetailSection>
  );
}

function TaskHistory({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
}) {
  const detailQuery = useFirstmateTask(environmentId, task.id);
  // The snapshot is newer than a loaded detail whenever the task changes, so
  // fields come from the snapshot and only the events come from the query.
  const events = detailQuery.data?.events ? readableTaskEvents(detailQuery.data.events) : null;
  const [expanded, setExpanded] = useState(false);
  const shown = events === null ? null : expanded ? events : events.slice(0, HISTORY_PREVIEW);
  return (
    <DetailSection
      title="Activity"
      trailing={
        events === null ? null : (
          <ShowAllToggle
            total={events.length}
            preview={HISTORY_PREVIEW}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        )
      }
    >
      {detailQuery.error && shown === null ? (
        <p className="text-sm text-destructive-foreground">Could not load the history.</p>
      ) : shown === null ? (
        <div className="space-y-2 pt-1" aria-busy>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">No history yet.</p>
      ) : (
        <ol className="space-y-1.5">
          {shown.map((event) => (
            <li key={event.id} className="flex gap-2.5 text-xs leading-4">
              <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
                {relativeAge(event.createdAt)}
              </span>
              <span className="min-w-0 text-foreground">
                {event.actor === "coordinator" ? null : (
                  <span className="text-muted-foreground">{EVENT_ACTOR_LABELS[event.actor]}: </span>
                )}
                {event.summary}
              </span>
            </li>
          ))}
        </ol>
      )}
    </DetailSection>
  );
}

export function TaskDetail({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
}) {
  const column = firstmateColumnForTask(task);
  const nextStep = taskNextStep(task);
  const coordinatorThreadId = use(CoordinatorThreadContext);
  const hasArtifacts = coordinatorThreadId !== null && (task.artifacts?.length ?? 0) > 0;
  const hasLinks = task.workerThreadId !== null || task.links.length > 0;
  return (
    <ScrollArea className="min-h-0 flex-1" scrollFade>
      <div className="space-y-5 px-4 pt-3 pb-6">
        <header className="space-y-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className={cn("size-1.5 rounded-full", COLUMN_DOT[column])} />
            <span>{COLUMN_LABELS[column]}</span>
            {nextStep === null ? (
              <>
                <span aria-hidden>·</span>
                <span>{taskStatusLabel(task)}</span>
              </>
            ) : null}
            <span className="ms-auto">Updated {relativeAge(task.updatedAt)}</span>
          </div>
          <div className="flex items-start gap-1">
            <h3 className="min-w-0 flex-1 text-base leading-6 font-semibold text-foreground">
              {task.title}
            </h3>
            <TaskPriorityToggle environmentId={environmentId} task={task} />
          </div>
          <TaskProgressLine task={task} />
        </header>
        {nextStep !== null ? (
          <NextStepCard environmentId={environmentId} task={task} nextStep={nextStep} />
        ) : null}
        {task.closeEvidence ? (
          <DetailSection title={task.state === "dropped" ? "Why it was dropped" : "Evidence"}>
            <DetailText>{task.closeEvidence}</DetailText>
          </DetailSection>
        ) : null}
        <DoneCriteria text={task.definitionOfDone} />
        {task.standup != null ? (
          <DetailSection title="Standup">
            <DetailText>{standupDatesLabel(task.standup)}</DetailText>
          </DetailSection>
        ) : null}
        {hasArtifacts || hasLinks ? (
          <DetailSection title="Artifacts">
            <div className="space-y-1.5">
              {hasArtifacts ? (
                <FirstmateArtifactList
                  environmentId={environmentId}
                  threadId={coordinatorThreadId}
                  artifacts={task.artifacts ?? []}
                />
              ) : null}
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
        <DetailSection title="Request">
          <ExpandableText
            text={task.intent}
            expandLabel="Show full request"
            className="border-s-2 border-border ps-2.5 text-sm leading-5 text-muted-foreground"
          />
        </DetailSection>
        <TaskHistory environmentId={environmentId} task={task} />
        <p className="text-2xs text-muted-foreground/70">
          Opened {relativeAge(task.createdAt)}
          {task.closedAt ? ` · Closed ${relativeAge(task.closedAt)}` : null}
        </p>
      </div>
    </ScrollArea>
  );
}
