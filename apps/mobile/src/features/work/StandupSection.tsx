/**
 * The user's standup to-dos at the top of the Work tab, whichever agent is
 * selected, drawn like a status section. A row selects the owning agent and
 * opens its worker chat, or the task's detail when it has no worker; an item
 * without a task opens Firstmate's chat. Hidden while the list is empty or the
 * server has no standup.
 */
import {
  standupNeedsYouCount,
  standupStartedLabel,
  standupTarget,
} from "@t3tools/client-runtime/firstmate/standup";
import {
  type AgentProfile,
  type EnvironmentId,
  type StandupItem,
  standupProgress,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { useStandup } from "../../state/agents";
import { WorkerStatusDot } from "./WorkerStatusDot";

export interface StandupOpen {
  readonly item: StandupItem;
  readonly ownerAgentId: string | null;
}

function StandupRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: StandupItem;
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly first: boolean;
  readonly now: Date;
  readonly onOpen: (item: StandupItem) => void;
}) {
  const { item } = props;
  const owner = props.agents.find((agent) => agent.id === item.agentId) ?? null;
  const needsYou = standupProgress(item.task, null) === "needs_you";
  const detail = [
    item.task === null ? "No task yet" : null,
    owner?.name,
    standupStartedLabel(item.startedAt, props.now),
  ]
    .filter(Boolean)
    .join(" · ");
  const workerThreadId = item.task?.workerThreadId ?? null;
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[needsYou ? "Needs your input" : null, item.text, detail]
        .filter(Boolean)
        .join(", ")}
      disabled={standupTarget(item, props.agents) === null}
      onPress={() => props.onOpen(item)}
      className={cn("gap-1 px-4 py-3", !props.first && "border-t border-border")}
    >
      <View className="flex-row items-center gap-2">
        {needsYou ? (
          <Text className="font-t3-bold text-danger-foreground" textRole="body">
            !
          </Text>
        ) : null}
        <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={2}>
          {item.text}
        </Text>
        {workerThreadId !== null ? (
          <WorkerStatusDot
            environmentId={props.environmentId}
            workerThreadId={workerThreadId}
            size={8}
          />
        ) : null}
      </View>
      <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
        {detail}
      </Text>
    </RowPressable>
  );
}

export function StandupSection(props: {
  readonly environmentId: EnvironmentId;
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly onOpen: (item: StandupItem) => void;
}) {
  const standup = useStandup(props.environmentId);
  const items = standup.data?.items ?? [];
  if (items.length === 0) return null;
  const needsYou = standupNeedsYouCount(items);
  const now = new Date();
  return (
    <View className="gap-2">
      <View accessibilityRole="header" className="flex-row items-center gap-2 px-2 py-1">
        <View className="size-[7px] rounded-full bg-primary" />
        <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
          Standup
        </Text>
        <Text textRole="footnote" className="tabular-nums text-foreground-muted">
          {items.length}
        </Text>
        {needsYou > 0 ? (
          <Text textRole="footnote" className="ml-auto tabular-nums text-danger-foreground">
            {needsYou} need you
          </Text>
        ) : null}
      </View>
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {items.map((item, index) => (
          <StandupRow
            key={item.id}
            environmentId={props.environmentId}
            item={item}
            agents={props.agents}
            first={index === 0}
            now={now}
            onOpen={props.onOpen}
          />
        ))}
      </View>
    </View>
  );
}
