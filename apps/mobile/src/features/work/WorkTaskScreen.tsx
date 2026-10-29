import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { firstmateColumnForTask } from "@t3tools/client-runtime/firstmate/board";
import { COLUMN_LABELS, taskStatusLabel } from "@t3tools/client-runtime/firstmate/tasks";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type FirstmateTask,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { relativeTime } from "../../lib/time";
import { NativeScrollViewMarker as ScrollViewMarker } from "../../native/NativeScrollViewMarker";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useFirstmateCommands } from "../../state/firstmate";
import { useEnvironmentScope } from "../../state/session";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { TaskStatusDot } from "./TaskStatusDot";
import {
  WorkTaskActionButtons,
  WorkTaskApproveButton,
  WorkTaskReplyComposer,
  type WorkTaskSend,
} from "./WorkTaskActions";
import { workTaskNextStep } from "./WorkTaskModel";
import {
  WorkTaskArtifacts,
  WorkTaskDoneCriteria,
  WorkTaskHistory,
  WorkTaskLinks,
  WorkTaskNextStepCard,
  WorkTaskProgress,
  WorkTaskRequest,
  WorkTaskSection,
  WorkTaskText,
} from "./WorkTaskSections";
import { sendWorkTaskMessage, useWorkTaskLookup } from "./WorkTaskState";

export type WorkTaskParams = {
  readonly environmentId: string;
  readonly taskId: string;
  /** The board the task is on; omitted opens it from Firstmate's or any agent's board. */
  readonly agentId?: string;
};

/**
 * One task's detail, led by its next step, with the requests the phone can
 * make of the agent's coordinator: approve, close, park, cancel, reopen, or
 * a free-text reply.
 */
export function WorkTaskScreen({ route }: StaticScreenProps<WorkTaskParams>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const lookup = useWorkTaskLookup(environmentId, route.params.taskId, route.params.agentId);
  const navigation = useNavigation();
  const title = lookup.kind === "found" ? lookup.agentName : "Task";
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ title }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={title} onBack={() => navigation.goBack()} />
      ) : null}
      {lookup.kind === "loading" ? (
        <View className="flex-1 items-center justify-center">
          <AppActivityIndicator />
        </View>
      ) : lookup.kind === "missing" ? (
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title="Task not found"
            detail="It may have been removed, or it is on a board this connection cannot see."
          />
        </View>
      ) : (
        // Split view swaps tasks by updating this route's params; the key drops the old draft.
        <TaskDetail
          key={`${environmentId}:${lookup.task.id}`}
          environmentId={environmentId}
          task={lookup.task}
          agentName={lookup.agentName}
          coordinatorThreadId={lookup.coordinatorThreadId}
        />
      )}
    </View>
  );
}

function PriorityToggle(props: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
}) {
  const commands = useFirstmateCommands(props.environmentId);
  const [pending, setPending] = useState(false);
  // An old server cannot save the field. Do not offer a control that does nothing.
  if (props.task.priority === undefined) return null;
  const priority = props.task.priority;
  const toggle = async () => {
    setPending(true);
    const result = await commands.setTaskPriority({
      environmentId: props.environmentId,
      input: { taskId: props.task.id, priority: !priority },
    });
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not change priority",
        cause instanceof Error ? cause.message : "The server did not save the change.",
      );
    }
  };
  const disabled = !commands.can.setTaskPriority || pending;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={priority ? "Remove priority" : "Mark as priority"}
      accessibilityState={{ selected: priority, disabled }}
      disabled={disabled}
      hitSlop={10}
      onPress={() => void toggle()}
      className="size-9 items-center justify-center rounded-full active:opacity-60"
      style={{ opacity: disabled && !pending ? 0.5 : 1 }}
    >
      <SymbolView
        name={priority ? "star.fill" : "star"}
        size={20}
        tintColorClassName={priority ? "accent-warning-foreground" : "accent-icon-muted"}
      />
    </Pressable>
  );
}

function TaskDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
  readonly agentName: string;
  readonly coordinatorThreadId: ThreadId | null;
}) {
  const { environmentId, task, agentName, coordinatorThreadId } = props;
  const selectDetail = useSelectWorkspaceDetail();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const bottomInset = keyboardVisible ? 8 : Math.max(insets.bottom, 12);
  const [composerHeight, setComposerHeight] = useState(64);
  const [busy, setBusy] = useState(false);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canSend = canOperate && coordinatorThreadId !== null;

  const openThread = (threadId: ThreadId) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(environmentId), threadId: String(threadId) },
    });

  const send = async (text: string, sentTitle: string): Promise<boolean> => {
    if (coordinatorThreadId === null || busy) return false;
    setBusy(true);
    const failure = await sendWorkTaskMessage({
      environmentId,
      threadId: coordinatorThreadId,
      text,
    }).then(
      () => null,
      (cause: unknown) => cause,
    );
    setBusy(false);
    if (failure !== null) {
      Dialog.alert(
        "Could not send",
        failure instanceof Error ? failure.message : "The message was not queued. Try again.",
      );
      return false;
    }
    Dialog.alert(sentTitle, `It is in ${agentName}'s chat, which acts on it next.`, [
      { text: "Done", style: "cancel" },
      { text: "Open chat", onPress: () => openThread(coordinatorThreadId) },
    ]);
    return true;
  };
  const sender: WorkTaskSend = { send, busy };

  const column = firstmateColumnForTask(task);
  const nextStep = workTaskNextStep(task, agentName);
  const artifacts = task.artifacts ?? [];
  const hasLinks = task.workerThreadId !== null || task.links.length > 0;

  return (
    <KeyboardAvoidingView automaticOffset behavior="height" className="flex-1">
      <ScrollViewMarker style={{ flex: 1 }}>
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 12,
            paddingBottom: canSend ? composerHeight + bottomInset + 24 : 32,
            gap: 24,
          }}
        >
          <View className="gap-1.5">
            <View className="flex-row items-center gap-1.5">
              <TaskStatusDot column={column} />
              <AppText textRole="label" className="text-foreground-muted">
                {COLUMN_LABELS[column]}
                {nextStep === null ? ` · ${taskStatusLabel(task)}` : ""}
              </AppText>
              <AppText textRole="label" className="ml-auto text-foreground-muted">
                Updated {relativeTime(task.updatedAt)} ago
              </AppText>
            </View>
            <View className="flex-row items-start gap-1">
              <AppText
                selectable
                accessibilityRole="header"
                textRole="title"
                className="min-w-0 flex-1 font-t3-semibold"
              >
                {task.title}
              </AppText>
              <PriorityToggle environmentId={environmentId} task={task} />
            </View>
            <WorkTaskProgress task={task} />
          </View>

          {nextStep !== null ? (
            <WorkTaskNextStepCard nextStep={nextStep}>
              {canSend ? (
                <WorkTaskApproveButton {...sender} task={task} agentName={agentName} />
              ) : null}
            </WorkTaskNextStepCard>
          ) : null}

          {canSend ? (
            <WorkTaskSection title={`Ask ${agentName}`}>
              <WorkTaskActionButtons {...sender} task={task} agentName={agentName} />
            </WorkTaskSection>
          ) : null}

          {task.closeEvidence ? (
            <WorkTaskSection title={task.state === "dropped" ? "Why it was dropped" : "Evidence"}>
              <WorkTaskText>{task.closeEvidence}</WorkTaskText>
            </WorkTaskSection>
          ) : null}

          <WorkTaskDoneCriteria text={task.definitionOfDone} />

          {artifacts.length > 0 || hasLinks ? (
            <WorkTaskSection title="Artifacts">
              <View className="gap-3">
                <WorkTaskArtifacts
                  environmentId={environmentId}
                  coordinatorThreadId={coordinatorThreadId}
                  artifacts={artifacts}
                />
                <WorkTaskLinks
                  environmentId={environmentId}
                  task={task}
                  onOpenWorker={openThread}
                />
              </View>
            </WorkTaskSection>
          ) : null}

          <WorkTaskRequest intent={task.intent} />

          <WorkTaskHistory environmentId={environmentId} taskId={task.id} />

          <AppText textRole="caption" className="text-foreground-muted">
            Opened {relativeTime(task.createdAt)} ago
            {task.closedAt ? ` · Closed ${relativeTime(task.closedAt)} ago` : ""}
          </AppText>
        </ScrollView>
      </ScrollViewMarker>
      {canSend ? (
        <WorkTaskReplyComposer
          {...sender}
          task={task}
          agentName={agentName}
          bottomInset={bottomInset}
          onHeightChange={setComposerHeight}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
