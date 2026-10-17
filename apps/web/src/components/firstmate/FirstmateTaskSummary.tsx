/**
 * Compact task context for surfaces that point at a worker chat, such as the
 * sidebar hover card. It mirrors the task detail sections without loading the
 * task event history.
 */
import type { EnvironmentId, FirstmateTask, ThreadId } from "@t3tools/contracts";
import { ChevronRightIcon, ImageIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useFirstmateTask } from "~/state/firstmate";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ExternalTaskLink } from "./FirstmateTaskLinks";
import {
  CoordinatorThreadContext,
  EVENT_ACTOR_LABELS,
  relativeAge,
  taskNextStep,
} from "./firstmateTasksShared";

const SECTION_LABEL_CLASS = "text-2xs font-medium text-muted-foreground";
const SECTION_TEXT_CLASS =
  "wrap-break-word whitespace-pre-wrap text-xs leading-5 text-foreground/80";

function SummarySection({
  title,
  children,
  defaultOpen = true,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly defaultOpen?: boolean;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="min-w-0" render={<section />}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1 text-left">
        <ChevronRightIcon
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none group-data-panel-open:rotate-90"
        />
        <span className={SECTION_LABEL_CLASS}>{title}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pt-0.5 pl-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function FirstmateTaskLinkList({
  environmentId,
  task,
  threadId,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
  readonly threadId: ThreadId | null;
  readonly className?: string;
}) {
  const links = task.links ?? [];
  if (links.length === 0) return null;
  return (
    <CoordinatorThreadContext value={threadId}>
      <div className={cn("flex min-w-0 flex-wrap gap-x-0.5", className)}>
        {links.map((link) => (
          <ExternalTaskLink
            key={`${link.label}:${link.url}`}
            environmentId={environmentId}
            link={link}
            className="inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        ))}
      </div>
    </CoordinatorThreadContext>
  );
}

export function FirstmateTaskSummary({
  environmentId,
  task,
  threadId,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
  readonly threadId: ThreadId | null;
  readonly className?: string;
}) {
  const nextStep = taskNextStep(task);
  const artifacts = task.artifacts ?? [];
  const evidenceTitle = task.state === "dropped" ? "Why it was dropped" : "Evidence";
  const detailQuery = useFirstmateTask(environmentId, task.id);
  const events = detailQuery.data?.events ?? null;

  return (
    <CoordinatorThreadContext value={threadId}>
      <div className={cn("min-w-0 space-y-2 border-t border-border/60 pt-2", className)}>
        <SummarySection title="What you asked" defaultOpen={false}>
          <p className={SECTION_TEXT_CLASS}>{task.intent}</p>
        </SummarySection>
        {nextStep !== null ? (
          <SummarySection title="Next step">
            <p className={SECTION_TEXT_CLASS}>{nextStep}</p>
          </SummarySection>
        ) : null}
        <SummarySection title="Done when" defaultOpen={false}>
          <p className={SECTION_TEXT_CLASS}>{task.definitionOfDone}</p>
        </SummarySection>
        {task.closeEvidence ? (
          <SummarySection title={evidenceTitle}>
            <p className={SECTION_TEXT_CLASS}>{task.closeEvidence}</p>
          </SummarySection>
        ) : null}
        {artifacts.length > 0 ? (
          <SummarySection title="Review">
            <div className="grid min-w-0 gap-1">
              {artifacts.map((artifact) =>
                artifact.kind === "link" ? (
                  <ExternalTaskLink
                    key={`${artifact.label}:${artifact.url}`}
                    environmentId={environmentId}
                    link={artifact}
                    className="inline-flex min-w-0 items-center gap-1.5 text-xs text-foreground/80 hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                ) : (
                  <div
                    key={`${artifact.label}:${artifact.url}`}
                    className="flex min-w-0 items-start gap-1.5"
                  >
                    <ImageIcon
                      aria-hidden
                      className="mt-0.5 size-3 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0">
                      <div className="wrap-break-word text-xs text-foreground/80">
                        {artifact.label}
                      </div>
                      {artifact.caption?.trim() ? (
                        <div className="wrap-break-word text-2xs text-muted-foreground">
                          {artifact.caption}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ),
              )}
            </div>
          </SummarySection>
        ) : null}
        {(task.links ?? []).length > 0 ? (
          <SummarySection title="Links">
            <FirstmateTaskLinkList environmentId={environmentId} task={task} threadId={threadId} />
          </SummarySection>
        ) : null}
        <SummarySection title="History" defaultOpen={false}>
          {detailQuery.error && events === null ? (
            <p className={SECTION_TEXT_CLASS}>Could not load the history.</p>
          ) : events === null ? (
            <p className="text-xs text-muted-foreground">Loading history…</p>
          ) : events.length === 0 ? (
            <p className="text-xs text-muted-foreground">No history yet.</p>
          ) : (
            <ol className="relative space-y-2 border-s border-border/70 ps-3">
              {events.toReversed().map((event) => (
                <li key={event.id} className="relative">
                  <span
                    aria-hidden
                    className="absolute top-1 -left-[0.9375rem] size-1.5 rounded-full bg-muted-foreground/50 ring-2 ring-background"
                  />
                  <p className="text-xs leading-5 text-foreground/80">{event.summary}</p>
                  <p className="text-2xs text-muted-foreground">
                    {EVENT_ACTOR_LABELS[event.actor]} · {relativeAge(event.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </SummarySection>
      </div>
    </CoordinatorThreadContext>
  );
}
