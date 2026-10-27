/**
 * The Work tab's agent row: the selected agent large (avatar, name, live
 * status or role, a count of tasks waiting on the user). Tapping it unfolds
 * a picker with every agent in the user's order, as rows or, past four
 * agents, a grid of avatars, plus New agent and Edit. Long-pressing an
 * agent moves it up or down the order, the phone's stand-in for web's drag.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { countFirstmateNeedsYou } from "@t3tools/client-runtime/firstmate/board";
import {
  AGENT_DEFAULT_COLOR,
  FIRSTMATE_AGENT_ID,
  type AgentProfile,
  type EnvironmentId,
  type FirstmateSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { RowPressable } from "../../components/ui/RowPressable";
import { cn } from "../../lib/cn";
import { useAgentTasks } from "../../state/agents";
import { useThreadShell } from "../../state/entities";
import { useFirstmateHome } from "../../state/firstmate";
import { resolveThreadListV2Status } from "../threads/threadListV2";
import { AgentAvatar } from "./AgentAvatar";
import {
  AGENT_PICKER_ROW_LIMIT,
  agentPresentation,
  agentRoleLine,
  moveAgent,
} from "./agent-switcher.logic";
import { workerStatusPresentation } from "./workStatus";

/** Tasks waiting on the user, from whichever stream holds the agent's board. */
function useNeedsYouCount(environmentId: EnvironmentId, agent: AgentProfile): number {
  const firstmate = agent.id === FIRSTMATE_AGENT_ID;
  const home = useFirstmateHome();
  const query = useAgentTasks(firstmate ? null : environmentId, firstmate ? null : agent.id);
  return countFirstmateNeedsYou(
    firstmate ? (home?.snapshot.tasks ?? []) : (query.data?.tasks ?? []),
  );
}

function NeedsYouBadge(props: { readonly count: number; readonly corner?: boolean }) {
  if (props.count === 0) return null;
  return (
    <View
      className={cn(
        "min-w-5 items-center rounded-full border border-warning-border bg-warning px-1.5",
        props.corner && "absolute -top-1 -right-1",
      )}
    >
      <Text textRole="caption" className="font-t3-bold tabular-nums text-warning-foreground">
        {props.count}
      </Text>
    </View>
  );
}

/** The coordinator chat's live status while it is busy or stuck; otherwise the role. */
function AgentSubtitle(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentProfile;
  readonly coordinatorThreadId: ThreadId | null;
}) {
  const shell = useThreadShell(
    props.coordinatorThreadId === null
      ? null
      : scopeThreadRef(props.environmentId, props.coordinatorThreadId),
  );
  const status = shell === null ? null : resolveThreadListV2Status(shell);
  const live =
    status === "working" || status === "approval" || status === "input" || status === "failed"
      ? workerStatusPresentation(status, false)
      : null;
  if (live !== null) {
    return (
      <View className="flex-row items-center gap-1.5">
        <View className={cn("size-1.5 rounded-full", live.dotClassName)} />
        <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
          {live.label}
        </Text>
      </View>
    );
  }
  return (
    <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
      {agentRoleLine(props.agent, props.coordinatorThreadId)}
    </Text>
  );
}

function PickerRow(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentProfile;
  readonly firstmate: FirstmateSnapshot | null;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly onLongPress: () => void;
}) {
  const presentation = agentPresentation(props.agent, props.firstmate);
  const needsYou = useNeedsYouCount(props.environmentId, props.agent);
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={
        needsYou > 0 ? `${presentation.name}, ${needsYou} need you` : presentation.name
      }
      accessibilityState={{ selected: props.selected }}
      accessibilityHint="Long press to reorder"
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      className="flex-row items-center gap-3 px-4 py-2.5"
    >
      <AgentAvatar
        icon={presentation.icon}
        color={props.agent.color ?? AGENT_DEFAULT_COLOR}
        size={30}
        environmentId={props.environmentId}
        avatarAttachmentId={props.agent.avatarAttachmentId}
      />
      <View className="min-w-0 flex-1">
        <Text
          textRole="body"
          className={props.selected ? "font-t3-medium text-foreground" : "text-foreground"}
          numberOfLines={1}
        >
          {presentation.name}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
          {agentRoleLine(props.agent, presentation.coordinatorThreadId)}
        </Text>
      </View>
      <NeedsYouBadge count={needsYou} />
      {props.selected ? (
        <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
      ) : null}
    </RowPressable>
  );
}

function PickerTile(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentProfile;
  readonly firstmate: FirstmateSnapshot | null;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly onLongPress: () => void;
}) {
  const presentation = agentPresentation(props.agent, props.firstmate);
  const needsYou = useNeedsYouCount(props.environmentId, props.agent);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        needsYou > 0 ? `${presentation.name}, ${needsYou} need you` : presentation.name
      }
      accessibilityState={{ selected: props.selected }}
      accessibilityHint="Long press to reorder"
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      className={cn(
        "w-18 items-center gap-1 rounded-xl py-2 active:opacity-70",
        props.selected && "bg-subtle-strong",
      )}
    >
      <View>
        <AgentAvatar
          icon={presentation.icon}
          color={props.agent.color ?? AGENT_DEFAULT_COLOR}
          size={40}
          environmentId={props.environmentId}
          avatarAttachmentId={props.agent.avatarAttachmentId}
        />
        <NeedsYouBadge count={needsYou} corner />
      </View>
      <Text textRole="caption" className="px-1 text-center text-foreground" numberOfLines={1}>
        {presentation.name}
      </Text>
    </Pressable>
  );
}

function PickerAction(props: {
  readonly label: string;
  readonly icon: "plus" | "pencil";
  readonly onPress: () => void;
}) {
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className="flex-row items-center gap-3 px-4 py-3"
    >
      <View className="size-[30px] items-center justify-center">
        <SymbolView name={props.icon} size={18} tintColorClassName="accent-icon" />
      </View>
      <Text textRole="body" className="text-foreground">
        {props.label}
      </Text>
    </RowPressable>
  );
}

export function AgentSwitcher(props: {
  readonly environmentId: EnvironmentId;
  /** Every agent in the user's saved order. */
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly selectedAgent: AgentProfile;
  readonly onSelect: (agent: AgentProfile) => void;
  readonly onNewAgent: () => void;
  readonly onEdit: (agent: AgentProfile) => void;
  /** Saves a new order of every agent's id. */
  readonly onReorder: (agentIds: ReadonlyArray<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const firstmate = useFirstmateHome()?.snapshot ?? null;
  const { selectedAgent, environmentId } = props;
  const presentation = agentPresentation(selectedAgent, firstmate);
  const needsYou = useNeedsYouCount(environmentId, selectedAgent);
  const grid = props.agents.length > AGENT_PICKER_ROW_LIMIT;
  const choose = (agent: AgentProfile) => {
    setOpen(false);
    if (agent.id !== selectedAgent.id) props.onSelect(agent);
  };
  const reorder = (agent: AgentProfile) => {
    const ids = props.agents.map((entry) => String(entry.id));
    if (ids.length < 2) return;
    const move = (direction: "up" | "down") => props.onReorder(moveAgent(ids, agent.id, direction));
    const index = ids.indexOf(agent.id);
    Dialog.alert(agentPresentation(agent, firstmate).name, undefined, [
      ...(index > 0 ? [{ text: "Move up", onPress: () => move("up") }] : []),
      ...(index < ids.length - 1 ? [{ text: "Move down", onPress: () => move("down") }] : []),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };
  return (
    <View className="overflow-hidden rounded-2xl bg-grouped-card">
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={`${presentation.name}${needsYou > 0 ? `, ${needsYou} need you` : ""}. Switch agent`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        className="flex-row items-center gap-3 px-4 py-3"
      >
        <AgentAvatar
          icon={presentation.icon}
          color={selectedAgent.color ?? AGENT_DEFAULT_COLOR}
          size={44}
          environmentId={environmentId}
          avatarAttachmentId={selectedAgent.avatarAttachmentId}
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="headline" className="font-t3-bold text-foreground" numberOfLines={1}>
            {presentation.name}
          </Text>
          <AgentSubtitle
            environmentId={environmentId}
            agent={selectedAgent}
            coordinatorThreadId={presentation.coordinatorThreadId}
          />
        </View>
        <NeedsYouBadge count={needsYou} />
        <SymbolView
          name={open ? "chevron.up" : "chevron.down"}
          size={14}
          tintColorClassName="accent-chevron"
        />
      </RowPressable>
      {open ? (
        <View className="border-t border-border">
          {grid ? (
            <View className="flex-row flex-wrap gap-1 px-3 py-2">
              {props.agents.map((agent) => (
                <PickerTile
                  key={agent.id}
                  environmentId={environmentId}
                  agent={agent}
                  firstmate={firstmate}
                  selected={agent.id === selectedAgent.id}
                  onPress={() => choose(agent)}
                  onLongPress={() => reorder(agent)}
                />
              ))}
            </View>
          ) : (
            props.agents.map((agent) => (
              <PickerRow
                key={agent.id}
                environmentId={environmentId}
                agent={agent}
                firstmate={firstmate}
                selected={agent.id === selectedAgent.id}
                onPress={() => choose(agent)}
                onLongPress={() => reorder(agent)}
              />
            ))
          )}
          <View className="border-t border-border">
            <PickerAction
              label="New agent"
              icon="plus"
              onPress={() => {
                setOpen(false);
                props.onNewAgent();
              }}
            />
            <PickerAction
              label={`Edit ${presentation.name}`}
              icon="pencil"
              onPress={() => {
                setOpen(false);
                props.onEdit(selectedAgent);
              }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}
