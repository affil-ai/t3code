/**
 * Shared external-link list for task cards in the agent sidebar.
 */
import type { EnvironmentId, FirstmateTask, ThreadId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { ExternalTaskLink } from "./FirstmateTaskLinks";
import { CoordinatorThreadContext } from "./firstmateTasksShared";

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
