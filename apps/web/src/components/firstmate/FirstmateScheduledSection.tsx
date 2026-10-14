/**
 * The Tasks panel's last section: the scheduled tasks bound to the agent's
 * coordinator chat, live from the server's scheduled-task subscription. Each
 * row shows the schedule and next run, with run-now, pause, and edit. The
 * section lists only this chat's tasks; the settings page has them all.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { CalendarClockIcon, PencilIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { relativeLabel, scheduleLabel } from "../settings/ScheduledTasksSettings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-muted-foreground/40",
  running: "bg-sky-500",
  succeeded: "bg-success",
  failed: "bg-destructive",
};

function reportFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );
}

export function ScheduledSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const canOperate = useAtomValue(
    serverEnvironment.runScheduledTaskNow.permissionAtom(environmentId),
  );
  const tasksQuery = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "agent scheduled task toggle",
  });
  const runTaskNow = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "agent scheduled task run now",
  });
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const tasks = (tasksQuery.data?.tasks ?? []).filter((task) => task.threadId === threadId);

  const toggleEnabled = async (task: ScheduledTask, enabled: boolean) => {
    if (busyTaskId !== null || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    setBusyTaskId(task.id);
    const result = await setTaskEnabled({ environmentId, input: { id: task.id, enabled } });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not update the scheduled task", squashAtomCommandFailure(result));
    }
  };
  const runNow = async (task: ScheduledTask) => {
    if (busyTaskId !== null || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return;
    setBusyTaskId(task.id);
    const result = await runTaskNow({ environmentId, input: { id: task.id } });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not run the scheduled task", squashAtomCommandFailure(result));
    }
  };
  const openSettings = (taskId?: ScheduledTask["id"]) =>
    void navigate({
      to: "/settings/scheduled-tasks",
      search: { environmentId, ...(taskId === undefined ? {} : { taskId }) },
    });

  return (
    <section aria-label="Scheduled" className="flex min-w-0 flex-col">
      <header className="flex h-7 shrink-0 items-center gap-1.5 px-1.5">
        <CalendarClockIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <h2 className="truncate text-xs font-medium text-foreground">Scheduled</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                className="ml-auto"
                aria-label="New scheduled task"
                onClick={() => openSettings()}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>New scheduled task</TooltipPopup>
        </Tooltip>
      </header>
      {tasksQuery.error !== null ? (
        <p className="px-1.5 pt-0.5 pb-1 text-xs text-destructive">
          Could not load scheduled tasks.
        </p>
      ) : tasks.length === 0 ? (
        <p className="px-1.5 pt-0.5 pb-1 text-xs text-muted-foreground/70">
          Nothing scheduled for this chat
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tasks.map((task) => (
            <li
              key={task.id}
              className="group/row flex items-center gap-2 rounded-lg border border-border/70 bg-card px-2.5 py-2 text-card-foreground shadow-xs/5"
            >
              <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
                <CalendarClockIcon className="size-3.5 text-muted-foreground" />
                <span
                  aria-hidden
                  className={cn(
                    "absolute -top-0.5 -right-0.5 size-1.5 rounded-full",
                    STATUS_DOT_CLASS[task.lastRunStatus],
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm leading-5 font-medium">{task.title}</p>
                <p className="truncate text-2xs text-muted-foreground/80">
                  {scheduleLabel(task.schedule)}
                  {task.enabled && task.nextRunAt !== null
                    ? ` · next ${relativeLabel(task.nextRunAt)}`
                    : task.enabled
                      ? ""
                      : " · paused"}
                </p>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Edit ${task.title}`}
                      onClick={() => openSettings(task.id)}
                    />
                  }
                >
                  <PencilIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>Edit</TooltipPopup>
              </Tooltip>
              {/* A webhook task runs from its URL; there is no request to run it with. */}
              {task.schedule.type === "webhook" ? null : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Run ${task.title} now`}
                        disabled={
                          !canOperate || busyTaskId !== null || task.lastRunStatus === "running"
                        }
                        onClick={() => void runNow(task)}
                      />
                    }
                  >
                    <PlayIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup>Run now</TooltipPopup>
                </Tooltip>
              )}
              <Switch
                checked={task.enabled}
                disabled={!canOperate || busyTaskId !== null}
                aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
                onCheckedChange={(enabled) => void toggleEnabled(task, enabled)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
