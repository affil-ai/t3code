/**
 * The Work tab's agent row, as on web: every agent's icon in the user's
 * order, each with a count of tasks waiting on the user. Tapping an icon
 * selects that agent; the selected agent's name and live status sit below.
 * Long-pressing an icon moves it in the order, the phone's stand-in for
 * web's drag.
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
import { Pressable, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useAgentTasks } from "../../state/agents";
import { useThreadShell } from "../../state/entities";
import { useFirstmateHome } from "../../state/firstmate";
import { resolveThreadListV2Status } from "../threads/threadListV2";
import { AgentAvatar } from "./AgentAvatar";
import { agentPresentation, agentRoleLine, moveAgent } from "./agent-switcher.logic";
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

function AgentTab(props: {
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
      accessibilityRole="tab"
      accessibilityLabel={
        needsYou > 0 ? `${presentation.name}, ${needsYou} need you` : presentation.name
      }
      accessibilityState={{ selected: props.selected }}
      accessibilityHint={
        props.selected ? "Opens the chat. Long press to reorder" : "Long press to reorder"
      }
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      className={cn(
        "rounded-xl border-2 p-1 active:opacity-70",
        props.selected ? "border-primary" : "border-transparent",
      )}
    >
      <AgentAvatar
        icon={presentation.icon}
        color={props.agent.color ?? AGENT_DEFAULT_COLOR}
        size={40}
        environmentId={props.environmentId}
        avatarAttachmentId={props.agent.avatarAttachmentId}
      />
      <NeedsYouBadge count={needsYou} corner />
    </Pressable>
  );
}

export function AgentSwitcher(props: {
  readonly environmentId: EnvironmentId;
  /** Every agent in the user's saved order. */
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly selectedAgent: AgentProfile;
  /** Also called for the selected agent, which reopens its chat. */
  readonly onSelect: (agent: AgentProfile) => void;
  /** Saves a new order of every agent's id. */
  readonly onReorder: (agentIds: ReadonlyArray<string>) => void;
}) {
  const firstmate = useFirstmateHome()?.snapshot ?? null;
  const { selectedAgent, environmentId } = props;
  const presentation = agentPresentation(selectedAgent, firstmate);
  const reorder = (agent: AgentProfile) => {
    const ids = props.agents.map((entry) => String(entry.id));
    if (ids.length < 2) return;
    const move = (direction: "up" | "down") => props.onReorder(moveAgent(ids, agent.id, direction));
    const index = ids.indexOf(agent.id);
    Dialog.alert(agentPresentation(agent, firstmate).name, undefined, [
      ...(index > 0 ? [{ text: "Move left", onPress: () => move("up") }] : []),
      ...(index < ids.length - 1 ? [{ text: "Move right", onPress: () => move("down") }] : []),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };
  return (
    <View className="gap-2">
      <View accessibilityRole="tablist" className="flex-row flex-wrap gap-1">
        {props.agents.map((agent) => (
          <AgentTab
            key={agent.id}
            environmentId={environmentId}
            agent={agent}
            firstmate={firstmate}
            selected={agent.id === selectedAgent.id}
            onPress={() => props.onSelect(agent)}
            onLongPress={() => reorder(agent)}
          />
        ))}
      </View>
      <View className="gap-0.5 px-1">
        <Text textRole="headline" className="font-t3-bold text-foreground" numberOfLines={1}>
          {presentation.name}
        </Text>
        <AgentSubtitle
          environmentId={environmentId}
          agent={selectedAgent}
          coordinatorThreadId={presentation.coordinatorThreadId}
        />
      </View>
    </View>
  );
}
