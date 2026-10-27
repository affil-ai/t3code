/**
 * The Tasks panel's last section, Automations: the scheduled tasks bound to the agent's
 * coordinator chat, live from the server's scheduled-task subscription. Each
 * row shows the schedule and next run; editing, run-now, and pause live in the
 * edit dialog, which opens over the panel. The section lists only this chat's tasks; the settings page has
 * them all.
 */
import { type EnvironmentId, type ScheduledTask, type ThreadId } from "@t3tools/contracts";
import { CalendarClockIcon, PencilIcon, PlusIcon } from "lucide-react";

import { useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import {
  ScheduledRelativeLabel,
  ScheduledTaskEditorDialog,
  scheduleLabel,
} from "../settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-muted-foreground/40",
  running: "bg-sky-500",
  succeeded: "bg-success",
  failed: "bg-destructive",
};

export function ScheduledSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const coordinator = useThreadShell({ environmentId, threadId });
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const tasks = (tasksQuery.data?.tasks ?? []).filter((task) => task.threadId === threadId);
  // The editor opens over the panel; null task creates one bound to this chat.
  const [editing, setEditing] = useState<{ readonly task: ScheduledTask | null } | null>(null);

  return (
    <section aria-label="Automations" className="flex min-w-0 flex-col">
      <header className="flex h-7 shrink-0 items-center gap-1.5 px-1.5">
        <CalendarClockIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <h2 className="truncate text-xs font-medium text-foreground">Automations</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                className="ml-auto"
                aria-label="New automation"
                onClick={() => setEditing({ task: null })}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>New automation</TooltipPopup>
        </Tooltip>
      </header>
      {tasksQuery.error !== null ? (
        <p className="px-1.5 pt-0.5 pb-1 text-xs text-destructive">Could not load automations.</p>
      ) : tasks.length === 0 ? (
        <p className="px-1.5 pt-0.5 pb-1 text-xs text-muted-foreground/70">
          No automations for this chat
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((task) => (
            <li
              key={task.id}
              className="group/row flex items-center gap-2 rounded-lg border border-border/70 bg-card px-2.5 py-2 text-card-foreground shadow-xs/5"
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  STATUS_DOT_CLASS[task.lastRunStatus],
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm leading-5 font-medium">{task.title}</p>
                <p className="truncate text-2xs text-muted-foreground/80">
                  {scheduleLabel(task.schedule)}
                  {task.enabled && task.nextRunAt !== null ? (
                    <>
                      {" · next "}
                      <ScheduledRelativeLabel value={task.nextRunAt} />
                    </>
                  ) : task.enabled ? (
                    ""
                  ) : (
                    " · paused"
                  )}
                </p>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Edit ${task.title}`}
                      onClick={() => setEditing({ task })}
                    />
                  }
                >
                  <PencilIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Edit</TooltipPopup>
              </Tooltip>
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
    </section>
  );
}

const EMPTY_SCOPE_SEARCH = {};
const ignoreScopeChange = () => {};
