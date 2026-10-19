/**
 * One task's detail in the Tasks panel: what was asked, when it is done,
 * evidence, review artifacts, links, and the event history.
 *
 * @module FirstmateTaskDetail
 */
import type { EnvironmentId, FirstmateTask } from "@t3tools/contracts";
import { type ReactNode, use } from "react";

import { cn } from "~/lib/utils";
import { useFirstmateTask } from "~/state/firstmate";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { firstmateColumnForTask } from "./firstmateBoard.logic";
import { FirstmateArtifactList } from "./FirstmateTaskArtifacts";
import { TaskPriorityStar, TaskPriorityToggle } from "./TaskPriority";
import { ExternalTaskLink, WorkerThreadLink } from "./FirstmateTaskLinks";
import {
  COLUMN_DOT,
  COLUMN_LABELS,
  CoordinatorThreadContext,
  EVENT_ACTOR_LABELS,
  relativeAge,
  taskNextStep,
  taskStatusLabel,
} from "./firstmateTasksShared";

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

export function TaskDetail({
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
  const nextStep = taskNextStep(task);
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
          <h3 className="text-base leading-6 font-semibold text-foreground">
            {task.priority ? (
              <>
                <TaskPriorityStar />{" "}
              </>
            ) : null}
            {task.title}
          </h3>
          <TaskPriorityToggle environmentId={environmentId} task={task} />
        </header>
        <DetailSection title="What you asked">
          <DetailText>{task.intent}</DetailText>
        </DetailSection>
        {nextStep !== null ? (
          <DetailSection title="Next step">
            <DetailText>{nextStep}</DetailText>
          </DetailSection>
        ) : null}
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
