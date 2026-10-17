/**
 * Compact task context for surfaces that point at a worker chat, such as the
 * sidebar hover card. It mirrors the task detail sections without loading the
 * task event history.
 */
import type { EnvironmentId, FirstmateTask, ThreadId } from "@t3tools/contracts";
import { ImageIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ExternalTaskLink, WorkerThreadLink } from "./FirstmateTaskLinks";
import {
  CoordinatorThreadContext,
  relativeAge,
  taskNextStep,
  taskStatusLabel,
} from "./firstmateTasksShared";

const SECTION_LABEL_CLASS = "text-2xs font-medium text-muted-foreground";
const SECTION_TEXT_CLASS =
  "wrap-break-word whitespace-pre-wrap text-xs leading-5 text-foreground/80";

function SummarySection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-0.5">
      <h3 className={SECTION_LABEL_CLASS}>{title}</h3>
      {children}
    </section>
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
  if (task.workerThreadId === null && links.length === 0) return null;
  return (
    <CoordinatorThreadContext value={threadId}>
      <div className={cn("flex min-w-0 flex-wrap gap-x-0.5", className)}>
        {task.workerThreadId !== null ? (
          <WorkerThreadLink
            environmentId={environmentId}
            task={task}
            className="inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        ) : null}
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
  const hasLinks = task.workerThreadId !== null || (task.links ?? []).length > 0;

  return (
    <CoordinatorThreadContext value={threadId}>
      <div className={cn("min-w-0 space-y-2 border-t border-border/60 pt-2", className)}>
        <div className="min-w-0 space-y-0.5">
          <div className="text-2xs font-medium text-muted-foreground">Task</div>
          <div className="wrap-break-word text-sm font-medium text-foreground">{task.title}</div>
          <div className="text-2xs text-muted-foreground">{taskStatusLabel(task)}</div>
        </div>
        <SummarySection title="What you asked">
          <p className={SECTION_TEXT_CLASS}>{task.intent}</p>
        </SummarySection>
        {nextStep !== null ? (
          <SummarySection title="Next step">
            <p className={SECTION_TEXT_CLASS}>{nextStep}</p>
          </SummarySection>
        ) : null}
        <SummarySection title="Done when">
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
                    className="inline-flex min-w-0 items-center gap-1.5 text-xs text-foreground/80 hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
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
        {hasLinks ? (
          <SummarySection title="Links">
            <FirstmateTaskLinkList environmentId={environmentId} task={task} threadId={threadId} />
          </SummarySection>
        ) : null}
        <SummarySection title="History">
          <p className="text-xs leading-5 text-foreground/80">
            Opened {relativeAge(task.createdAt)} · Updated {relativeAge(task.updatedAt)}
            {task.closedAt ? ` · Closed ${relativeAge(task.closedAt)}` : null}
          </p>
        </SummarySection>
      </div>
    </CoordinatorThreadContext>
  );
}
