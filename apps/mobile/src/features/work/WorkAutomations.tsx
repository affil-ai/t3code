/**
 * The Work tab's Automations section: the scheduled tasks that post into the
 * agent's chat, live from the server, each opening the scheduled-task
 * editor. New automation starts one in the agent's project, bound to its
 * chat, as web's Automations section does.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScheduledTask, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatNextScheduledTaskRun } from "../settings/scheduledTaskPresentation";
import { automationScheduleLabel, coordinatorAutomations } from "./task-list.logic";
import { useWorkNavigation } from "./WorkNavigation";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-foreground-muted/40",
  running: "bg-adaptive-sky-600-400",
  succeeded: "bg-adaptive-emerald-600-400",
  failed: "bg-danger-foreground",
};

function automationDetail(task: ScheduledTask, now: number): string {
  const schedule = automationScheduleLabel(task.schedule);
  if (!task.enabled) return `${schedule} · Paused`;
  if (task.nextRunAt === null) return schedule;
  return `${schedule} · ${formatNextScheduledTaskRun(task.nextRunAt, now)}`;
}

export function WorkAutomations(props: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
}) {
  const { environmentId, coordinatorThreadId } = props;
  const [expanded, setExpanded] = useState(true);
  // Next-run labels read from when the section opened; the list itself stays live.
  const [now] = useState(Date.now);
  const navigation = useWorkNavigation();
  const coordinator = useThreadShell(scopeThreadRef(environmentId, coordinatorThreadId));
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const automations = coordinatorAutomations(query.data?.tasks ?? [], coordinatorThreadId);
  return (
    <View className="gap-2">
      <View className="flex-row items-center">
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel={`Automations, ${automations.length}`}
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          className="min-w-0 flex-1 flex-row items-center gap-2 rounded-lg px-2 py-1"
        >
          <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
            Automations
          </Text>
          <Text textRole="footnote" className="tabular-nums text-foreground-muted">
            {automations.length}
          </Text>
          <SymbolView
            name={expanded ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-chevron"
          />
        </RowPressable>
        <RowPressable
          accessibilityRole="button"
          accessibilityLabel="New automation"
          // The project comes from the agent's chat, which loads with the thread list.
          disabled={coordinator === null}
          onPress={() => {
            if (coordinator === null) return;
            navigation.newAutomation({
              environmentId,
              projectId: coordinator.projectId,
              threadId: coordinatorThreadId,
            });
          }}
          className={cn(
            "size-9 items-center justify-center rounded-full",
            !coordinator && "opacity-40",
          )}
        >
          <SymbolView name="plus" size={16} tintColorClassName="accent-icon" />
        </RowPressable>
      </View>
      {expanded ? (
        <View className="overflow-hidden rounded-2xl bg-grouped-card">
          {query.error !== null && query.data === null ? (
            <Text textRole="footnote" className="px-4 py-3 text-danger-foreground">
              Could not load automations.
            </Text>
          ) : automations.length === 0 ? (
            <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
              {query.data === null ? "Loading automations…" : "No automations"}
            </Text>
          ) : (
            automations.map((task, index) => (
              <RowPressable
                key={task.id}
                accessibilityRole="button"
                accessibilityLabel={`${task.title}, ${automationDetail(task, now)}`}
                onPress={() => navigation.editAutomation(environmentId, task)}
                className={cn(
                  "flex-row items-center gap-3 px-4 py-3",
                  index > 0 && "border-t border-border",
                )}
              >
                <View className={cn("size-2 rounded-full", STATUS_DOT_CLASS[task.lastRunStatus])} />
                <View className="min-w-0 flex-1">
                  <Text textRole="body" className="text-foreground" numberOfLines={1}>
                    {task.title}
                  </Text>
                  <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
                    {automationDetail(task, now)}
                  </Text>
                </View>
                <SymbolView name="chevron.right" size={13} tintColorClassName="accent-chevron" />
              </RowPressable>
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}
