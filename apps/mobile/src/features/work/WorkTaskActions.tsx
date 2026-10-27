/**
 * Task state changes from the phone. The coordinator owns the board, so each
 * action is a message in its chat asking it to approve, close, park, cancel
 * or reopen the task, and the reply composer sends free text the same way.
 */
import type { FirstmateTask } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { GlassSurface } from "../../components/ui/GlassSurface";
import {
  buildWorkTaskMessage,
  WORK_TASK_ACTION_LABELS,
  workTaskActionInstruction,
  workTaskActions,
  type WorkTaskAction,
} from "./WorkTaskModel";

export interface WorkTaskSend {
  /** Sends `text` to the coordinator chat; resolves true once it is queued. */
  readonly send: (text: string, sentTitle: string) => Promise<boolean>;
  readonly busy: boolean;
}

/** The task's quick requests, except approval, which the next-step card offers. */
export function WorkTaskActionButtons(
  props: WorkTaskSend & { readonly task: FirstmateTask; readonly agentName: string },
) {
  const actions = workTaskActions(props.task).filter((action) => action !== "approve");
  const run = (action: WorkTaskAction) => {
    const text = buildWorkTaskMessage(props.task, workTaskActionInstruction(props.task, action));
    const sentTitle = `Asked ${props.agentName}: ${WORK_TASK_ACTION_LABELS[action].toLowerCase()}`;
    if (action !== "cancel") {
      void props.send(text, sentTitle);
      return;
    }
    Dialog.confirm({
      title: "Cancel this task?",
      message: `${props.agentName} will be asked to close "${props.task.title}" as dropped.`,
      cancelText: "Keep task",
      confirmText: "Cancel task",
      destructive: true,
      onConfirm: () => void props.send(text, sentTitle),
    });
  };
  return (
    <View className="flex-row flex-wrap gap-2">
      {actions.map((action) => (
        <Button
          key={action}
          label={WORK_TASK_ACTION_LABELS[action]}
          tone={action === "cancel" ? "danger" : "secondary"}
          disabled={props.busy}
          onPress={() => run(action)}
        />
      ))}
    </View>
  );
}

/** Approves the next step from its card when the move is the user's. */
export function WorkTaskApproveButton(
  props: WorkTaskSend & { readonly task: FirstmateTask; readonly agentName: string },
) {
  if (!workTaskActions(props.task).includes("approve")) return null;
  return (
    <View className="mt-2">
      <Button
        label={WORK_TASK_ACTION_LABELS.approve}
        icon="checkmark"
        tone="contrast"
        disabled={props.busy}
        onPress={() =>
          void props.send(
            buildWorkTaskMessage(props.task, workTaskActionInstruction(props.task, "approve")),
            `Approved for ${props.agentName}`,
          )
        }
      />
    </View>
  );
}

/** A free-text reply about the task, pinned under the detail. */
export function WorkTaskReplyComposer(
  props: WorkTaskSend & {
    readonly task: FirstmateTask;
    readonly agentName: string;
    readonly bottomInset: number;
    readonly onHeightChange: (height: number) => void;
  },
) {
  const [body, setBody] = useState("");
  const submit = async () => {
    const submitted = body;
    if (!submitted.trim()) return;
    const sent = await props.send(
      buildWorkTaskMessage(props.task, submitted),
      `Reply sent to ${props.agentName}`,
    );
    if (sent) setBody((current) => (current === submitted ? "" : current));
  };
  return (
    <View className="absolute inset-x-4 bottom-0" style={{ paddingBottom: props.bottomInset }}>
      <GlassSurface
        chrome="none"
        onLayout={(event) => props.onHeightChange(event.nativeEvent.layout.height)}
        className="flex-row items-end gap-1 p-1"
      >
        <AppTextInput
          accessibilityLabel={`Reply to ${props.agentName} about this task`}
          multiline
          maxLength={20_000}
          placeholder={`Reply to ${props.agentName}…`}
          value={body}
          onChangeText={setBody}
          editable={!props.busy}
          className="max-h-36 min-h-12 min-w-0 flex-1 rounded-[24px] border-0 bg-transparent px-4 py-3 text-base text-foreground"
        />
        <View>
          <Button
            label="Send"
            tone="contrast"
            loading={props.busy}
            disabled={!body.trim()}
            onPress={() => void submit()}
          />
        </View>
      </GlassSurface>
    </View>
  );
}
