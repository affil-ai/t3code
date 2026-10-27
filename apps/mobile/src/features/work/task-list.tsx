/**
 * An agent's tasks in the board's sections, Backlog and Done folded. Each row carries the
 * board's attention marks (the priority star, a red "!" when the task waits
 * on the user), the next step, the worker's status, and its progress.
 * Tapping a row opens the task's detail.
 */
import type { EnvironmentId, FirstmateTask } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { buildTaskListSections, taskRowPresentation } from "./task-list.logic";
import { TaskStatusDot } from "./TaskStatusDot";
import { WorkerStatusDot } from "./WorkerStatusDot";

function TaskRow(props: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
  readonly first: boolean;
  readonly onOpen: (task: FirstmateTask) => void;
}) {
  const { task } = props;
  const row = taskRowPresentation(task);
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[
        row.needsYou ? "Needs your input" : null,
        row.priority ? "Priority" : null,
        task.title,
        row.detail,
        row.progress,
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={() => props.onOpen(task)}
      className={cn("gap-1 px-4 py-3", !props.first && "border-t border-border")}
    >
      <View className="flex-row items-center gap-2">
        {row.needsYou ? (
          <Text className="font-t3-bold text-danger-foreground" textRole="body">
            !
          </Text>
        ) : null}
        {row.priority ? (
          <SymbolView name="star.fill" size={13} tintColorClassName="accent-warning-foreground" />
        ) : null}
        <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
          {task.title}
        </Text>
        {task.workerThreadId !== null ? (
          <WorkerStatusDot
            environmentId={props.environmentId}
            workerThreadId={task.workerThreadId}
            size={8}
          />
        ) : null}
      </View>
      <Text
        textRole="footnote"
        className={row.needsYou ? "text-foreground" : "text-foreground-muted"}
        numberOfLines={2}
      >
        {row.detail}
      </Text>
      {row.progress !== null ? (
        <View className="flex-row items-center gap-2">
          <Text
            textRole="caption"
            className="shrink tabular-nums text-foreground-muted"
            numberOfLines={1}
          >
            {row.progress}
          </Text>
          {row.progressFraction !== null ? (
            <View className="h-1 w-16 overflow-hidden rounded-full bg-subtle-strong">
              <View
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.round(row.progressFraction * 100)}%` }}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </RowPressable>
  );
}

export function TaskList(props: {
  readonly environmentId: EnvironmentId;
  readonly tasks: ReadonlyArray<FirstmateTask>;
  readonly onOpenTask: (task: FirstmateTask) => void;
}) {
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const sections = buildTaskListSections(props.tasks, { backlogOpen, doneOpen });
  const hasOpenTasks = sections.some((section) => section.column !== "done");
  return (
    <View className="gap-5">
      {hasOpenTasks ? null : (
        <View className="items-center rounded-2xl bg-grouped-card px-6 py-8">
          <Text textRole="body" className="text-center text-foreground-muted">
            No open tasks
          </Text>
        </View>
      )}
      {sections.map((section) => {
        const heading = (
          <View className="flex-row items-center gap-2 px-2">
            <TaskStatusDot column={section.column} size={7} />
            <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
              {section.label}
            </Text>
            <Text textRole="footnote" className="tabular-nums text-foreground-muted">
              {section.count}
            </Text>
            {section.collapsible ? (
              <View className="ml-auto">
                <SymbolView
                  name={section.open ? "chevron.down" : "chevron.right"}
                  size={12}
                  tintColorClassName="accent-chevron"
                />
              </View>
            ) : null}
          </View>
        );
        return (
          <View key={section.column} className="gap-2">
            {section.collapsible ? (
              <RowPressable
                accessibilityRole="button"
                accessibilityLabel={`${section.label}, ${section.count}`}
                accessibilityState={{ expanded: section.open }}
                onPress={() =>
                  section.column === "done"
                    ? setDoneOpen((open) => !open)
                    : setBacklogOpen((open) => !open)
                }
                className="rounded-lg py-1"
              >
                {heading}
              </RowPressable>
            ) : (
              <View accessibilityRole="header" className="py-1">
                {heading}
              </View>
            )}
            {section.tasks.length > 0 ? (
              <View className="overflow-hidden rounded-2xl bg-grouped-card">
                {section.tasks.map((task, index) => (
                  <TaskRow
                    key={task.id}
                    environmentId={props.environmentId}
                    task={task}
                    first={index === 0}
                    onOpen={props.onOpenTask}
                  />
                ))}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
