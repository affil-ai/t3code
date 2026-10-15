/**
 * The sidebar's Automations section: the scheduled tasks bound to the
 * selected agent's chat, live from the server's scheduled-task subscription.
 * Each row shows the schedule and next run and opens the editor dialog, the
 * same one the Tasks panel's Scheduled section uses. Firstmate hides the
 * section while it has nothing scheduled; a custom agent always shows it,
 * since it is part of that agent's fixed layout.
 */
import { type EnvironmentId, type ScheduledTask, type ThreadId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import {
  ScheduledTaskEditorDialog,
  relativeLabel,
  scheduleLabel,
} from "../settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { Button } from "../ui/button";
import { SidebarGroup } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-sidebar-muted-foreground/40",
  running: "bg-sky-500",
  succeeded: "bg-success",
  failed: "bg-destructive",
};

export function AgentAutomationsSection({
  environmentId,
  threadId,
  alwaysShow,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly alwaysShow: boolean;
}) {
  const coordinator = useThreadShell({ environmentId, threadId });
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const tasks = (tasksQuery.data?.tasks ?? []).filter((task) => task.threadId === threadId);
  const [editing, setEditing] = useState<{ readonly task: ScheduledTask | null } | null>(null);
  if (!alwaysShow && tasks.length === 0 && editing === null) return null;
  return (
    <SidebarGroup aria-label="Automations" data-testid="agent-automations-section" className="mb-3">
      <div className="group/section-header mb-1 flex h-6 items-center justify-between pl-2 pr-1.5">
        <span className="flex items-center gap-1.5 text-xs font-medium text-sidebar-muted-foreground/80">
          Automations
          <span className="tabular-nums">{tasks.length}</span>
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="New automation"
                onClick={() => setEditing({ task: null })}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">New automation</TooltipPopup>
        </Tooltip>
      </div>
      {tasksQuery.error !== null ? (
        <p className="px-2 py-1 text-xs text-destructive">Could not load automations.</p>
      ) : tasks.length === 0 ? (
        <p className="px-2 py-1 text-sm text-sidebar-muted-foreground/70">No automations</p>
      ) : (
        <ul className="flex flex-col">
          {tasks.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => setEditing({ task })}
                className="flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sidebar-foreground/80 outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset"
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    STATUS_DOT_CLASS[task.lastRunStatus],
                  )}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm leading-4">{task.title}</span>
                  <span className="truncate text-2xs text-sidebar-muted-foreground/80">
                    {scheduleLabel(task.schedule)}
                    {task.enabled && task.nextRunAt !== null
                      ? ` · next ${relativeLabel(task.nextRunAt)}`
                      : task.enabled
                        ? ""
                        : " · paused"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        // The editor reads a settings scope; an empty one spans every project.
        <SettingsScopeProvider search={EMPTY_SCOPE_SEARCH} onChange={ignoreScopeChange}>
          <ScheduledTaskEditorDialog
            key={editing.task?.id ?? "new"}
            initialEnvironmentId={environmentId}
            task={editing.task}
            newTaskTarget={coordinator ? { projectId: coordinator.projectId, threadId } : undefined}
            onClose={() => setEditing(null)}
          />
        </SettingsScopeProvider>
      ) : null}
    </SidebarGroup>
  );
}

const EMPTY_SCOPE_SEARCH = {};
const ignoreScopeChange = () => {};
