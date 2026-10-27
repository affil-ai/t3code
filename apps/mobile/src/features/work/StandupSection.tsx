/**
 * The Standup section of the Work tab, as on web's sidebar: the user's open
 * standup tasks ahead of the board's sections. Firstmate lists every agent's;
 * another agent lists its own. A row shows its owner's icon and opens the
 * worker chat, or the task's details when it has no worker. Hidden while
 * empty or when the server has no standup.
 */
import { standupRowsForAgent, standupTarget } from "@t3tools/client-runtime/firstmate/standup";
import { COLUMN_LABELS } from "@t3tools/client-runtime/firstmate/tasks";
import {
  type AgentProfile,
  type EnvironmentId,
  FIRSTMATE_AGENT_ID,
  type ThreadId,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { useStandupTasks } from "../../state/agents";
import { TaskRow } from "./task-list";
import { TaskStatusDot } from "./TaskStatusDot";
import { useWorkNavigation } from "./WorkNavigation";

export function StandupSection(props: {
  readonly environmentId: EnvironmentId;
  /** Every unarchived agent, to find the chat a row opens. */
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly selectedAgentId: AgentProfile["id"];
  readonly onOpenChat: (threadId: ThreadId) => void;
}) {
  const navigation = useWorkNavigation();
  const standup = useStandupTasks(props.environmentId);
  const rows =
    standup.data === null ? null : standupRowsForAgent(standup.data.tasks, props.selectedAgentId);
  // Loading shows only before the first answer; a failure (a server without standup) hides it.
  if (rows === null ? !standup.isPending : rows.length === 0) return null;

  const heading = (
    <View accessibilityRole="header" className="flex-row items-center gap-2 px-2 py-1">
      <TaskStatusDot column="standup" size={7} />
      <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
        {COLUMN_LABELS.standup}
      </Text>
      {rows !== null ? (
        <Text textRole="footnote" className="tabular-nums text-foreground-muted">
          {rows.length}
        </Text>
      ) : null}
    </View>
  );
  return (
    <View className="gap-2">
      {heading}
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {rows === null ? (
          <View className="flex-row items-center gap-3 px-4 py-3">
            <AppActivityIndicator />
            <Text textRole="footnote" className="text-foreground-muted">
              Loading standup…
            </Text>
          </View>
        ) : (
          rows.map(({ agent, task }, index) => (
            <TaskRow
              key={task.id}
              environmentId={props.environmentId}
              task={task}
              owner={agent}
              first={index === 0}
              onOpen={() => {
                const target = standupTarget(task, agent.id, props.agents);
                if (target === null) return;
                if (target.kind === "thread") {
                  props.onOpenChat(target.threadId);
                  return;
                }
                navigation.openTask({
                  environmentId: String(props.environmentId),
                  taskId: String(task.id),
                  ...(agent.id === FIRSTMATE_AGENT_ID ? {} : { agentId: String(agent.id) }),
                });
              }}
            />
          ))
        )}
      </View>
    </View>
  );
}
