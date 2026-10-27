/**
 * The Work tab, mobile's Work sidebar: the agent icons, the selected agent's
 * tasks in the board's sections (Backlog and Done folded), and its
 * automations. As on web, an agent icon opens that agent's chat and a task
 * opens its worker's chat; a task's details are a button in that chat's
 * header. A phone shows it as one column; a split view keeps it in the
 * sidebar with chats opening in the detail column.
 */
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AgentProfile,
  EnvironmentId,
  FirstmateSnapshot,
  FirstmateTask,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAgentCommands, useAgentTasks } from "../../state/agents";
import { useFirstmateCommands, useFirstmateHome } from "../../state/firstmate";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { agentPresentation } from "./agent-switcher.logic";
import { AgentSwitcher } from "./agent-switcher";
import { TaskList } from "./task-list";
import { useDefaultAgentModelSelection } from "./useDefaultAgentModelSelection";
import { useSelectedAgent } from "./useSelectedAgent";
import { WorkAutomations } from "./WorkAutomations";
import { useWorkNavigation } from "./WorkNavigation";

export interface WorkOpenChat {
  (params: { readonly environmentId: string; readonly threadId: string }): void;
}

function CenteredMessage(props: { readonly title: string; readonly detail?: string }) {
  return (
    <View className="items-center gap-3 px-8 py-16">
      <AppActivityIndicator />
      <Text textRole="body" className="text-center font-t3-medium text-foreground">
        {props.title}
      </Text>
      {props.detail ? (
        <Text textRole="footnote" className="text-center text-foreground-muted">
          {props.detail}
        </Text>
      ) : null}
    </View>
  );
}

/** Starts the agent's coordinator chat with the model a new Scratch chat would use. */
function StartAgentCard(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentProfile;
  readonly name: string;
  readonly firstmate: boolean;
  readonly onStarted: (threadId: ThreadId) => void;
}) {
  const modelSelection = useDefaultAgentModelSelection(props.environmentId);
  const agentCommands = useAgentCommands(props.environmentId);
  const firstmateCommands = useFirstmateCommands(props.environmentId);
  const [starting, setStarting] = useState(false);
  const allowed = props.firstmate ? firstmateCommands.can.start : agentCommands.can.start;
  const start = async () => {
    if (modelSelection === null) return;
    setStarting(true);
    const result = props.firstmate
      ? await firstmateCommands.start({
          environmentId: props.environmentId,
          input: { modelSelection },
        })
      : await agentCommands.start({
          environmentId: props.environmentId,
          input: { agentId: props.agent.id, modelSelection },
        });
    setStarting(false);
    if (result._tag === "Success") {
      props.onStarted(result.value.threadId);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    Dialog.alert(
      `Could not start ${props.name}`,
      error instanceof Error && error.message ? error.message : "Try again in a moment.",
    );
  };
  return (
    <View className="items-center gap-3 rounded-2xl bg-grouped-card px-6 py-8">
      <Text textRole="headline" className="text-center font-t3-bold text-foreground">
        {props.name} isn't started
      </Text>
      <Text textRole="footnote" className="text-center text-foreground-muted">
        {modelSelection === null
          ? "Set up a provider on this environment to start a chat."
          : `Start a chat with ${props.name} to give it work. Its tasks and automations show here.`}
      </Text>
      <Button
        tone="primary"
        label={`Start ${props.name}`}
        loading={starting}
        disabled={!allowed || modelSelection === null}
        onPress={() => void start()}
      />
    </View>
  );
}

function AgentWork(props: {
  readonly environmentId: EnvironmentId;
  readonly agents: ReadonlyArray<AgentProfile>;
  readonly agent: AgentProfile;
  readonly isFirstmate: boolean;
  readonly selectAgent: (agentId: string | null) => void;
  readonly setAgentOrder: (agentIds: ReadonlyArray<string>) => void;
  readonly onOpenChat: WorkOpenChat;
}) {
  const { agent, isFirstmate } = props;
  const firstmateHome = useFirstmateHome();
  const navigation = useWorkNavigation();
  // Firstmate's board, name, and chat come from its own stream, which may live
  // elsewhere. Until that stream answers (or if it fails), Firstmate's board is
  // read like any agent's, so a broken stream shows an error, not a spinner.
  const firstmateStream = isFirstmate ? firstmateHome : null;
  const agentBoard = useAgentTasks(
    firstmateStream === null ? props.environmentId : null,
    firstmateStream === null ? agent.id : null,
  );
  const environmentId = firstmateStream?.environmentId ?? props.environmentId;
  const presentation = agentPresentation(agent, firstmateHome?.snapshot ?? null);
  const board: FirstmateSnapshot | null = firstmateStream?.snapshot ?? agentBoard.data;
  const openChat = (threadId: ThreadId) =>
    props.onOpenChat({ environmentId: String(environmentId), threadId: String(threadId) });
  // A task with a worker opens the worker's chat; one without opens its details.
  const openTask = (task: FirstmateTask) => {
    if (task.workerThreadId) {
      openChat(task.workerThreadId);
      return;
    }
    navigation.openTask({
      environmentId: String(environmentId),
      taskId: String(task.id),
      ...(isFirstmate ? {} : { agentId: String(agent.id) }),
    });
  };
  const selectAgent = (next: AgentProfile) => {
    props.selectAgent(next.id);
    const threadId = agentPresentation(next, firstmateHome?.snapshot ?? null).coordinatorThreadId;
    if (threadId !== null) openChat(threadId);
  };

  return (
    <View className="gap-6">
      <AgentSwitcher
        environmentId={props.environmentId}
        agents={props.agents}
        selectedAgent={agent}
        onSelect={selectAgent}
        onReorder={props.setAgentOrder}
      />
      {presentation.coordinatorThreadId === null ? (
        <StartAgentCard
          key={agent.id}
          environmentId={environmentId}
          agent={agent}
          name={presentation.name}
          firstmate={isFirstmate}
          onStarted={openChat}
        />
      ) : (
        <>
          {board === null ? (
            agentBoard.error !== null ? (
              <Text textRole="footnote" className="px-2 text-danger-foreground">
                Could not load tasks. {agentBoard.error}
              </Text>
            ) : (
              <CenteredMessage title="Loading tasks…" />
            )
          ) : (
            <TaskList environmentId={environmentId} tasks={board.tasks} onOpenTask={openTask} />
          )}
          <WorkAutomations
            key={`${environmentId}:${presentation.coordinatorThreadId}`}
            environmentId={environmentId}
            coordinatorThreadId={presentation.coordinatorThreadId}
          />
        </>
      )}
    </View>
  );
}

/** The Work tab. `sidebar` draws it in a split view's list column. */
export function WorkScreen(props: {
  readonly onOpenChat: WorkOpenChat;
  readonly sidebar?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const workspace = useWorkspaceTabs();
  const { environmentId, agents, selectedAgent, isFirstmate, selectAgent, setAgentOrder } =
    useSelectedAgent();
  return (
    <View className={props.sidebar ? "flex-1 bg-drawer" : "flex-1 bg-screen"}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={Platform.OS !== "android"}
        contentContainerClassName="gap-6 px-4 pt-3"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, workspace?.bottomClearance ?? 0) + 12,
        }}
      >
        {environmentId === null || selectedAgent === null ? (
          <CenteredMessage
            title="Connecting to your agents…"
            detail="Work needs a connected T3 Work server."
          />
        ) : (
          <AgentWork
            environmentId={environmentId}
            agents={agents}
            agent={selectedAgent}
            isFirstmate={isFirstmate}
            selectAgent={selectAgent}
            setAgentOrder={setAgentOrder}
            onOpenChat={props.onOpenChat}
          />
        )}
      </ScrollView>
    </View>
  );
}
