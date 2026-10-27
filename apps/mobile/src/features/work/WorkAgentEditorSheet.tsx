import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type AgentProfile, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText, AppTextInput, type AppTextInputProps } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { resetAndroidWorkspace } from "../../lib/android-workspace-navigation";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAgentCommands, useAgentsHome } from "../../state/agents";
import { useFirstmateCommands } from "../../state/firstmate";
import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_ROLE_MAX_LENGTH,
  type AgentEditorDraft,
  agentEditorErrors,
  agentEditorFailureMessage,
  agentEditorMode,
  agentEditorSubmission,
  initialAgentEditorDraft,
  stackShowsAgent,
} from "./agent-editor.logic";
import { AgentEditorColorPicker, AgentEditorIconGrid } from "./AgentEditorPickers";
import { AgentAvatar } from "./AgentAvatar";
import { useDefaultAgentModelSelection } from "./useDefaultAgentModelSelection";
import { useSelectedAgent } from "./useSelectedAgent";

export type WorkAgentEditorParams = {
  readonly environmentId: string;
  /** The agent to edit; omitted creates a new agent. */
  readonly agentId?: string;
};

/**
 * Creates an agent, or edits one's name, role, icon, and color, as web's
 * agent dialog does. Firstmate only takes a name and an icon and cannot be
 * archived. Avatar images show here but are uploaded from web.
 */
export function WorkAgentEditorSheet(props: StaticScreenProps<WorkAgentEditorParams>) {
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const agentId = props.route.params.agentId;
  const home = useAgentsHome();
  const agent =
    agentId === undefined || home?.environmentId !== environmentId
      ? null
      : (home.agents.find((candidate) => candidate.id === agentId) ?? null);

  if (agentId !== undefined && agent === null) {
    return <MissingAgent loading={home === null} />;
  }
  // Remount on a different agent so the draft starts from it.
  return <AgentEditorForm key={agent?.id ?? "new"} environmentId={environmentId} agent={agent} />;
}

function AgentEditorForm(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentProfile | null;
}) {
  const { environmentId, agent } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const agentCommands = useAgentCommands(environmentId);
  const firstmateCommands = useFirstmateCommands(environmentId);
  const modelSelection = useDefaultAgentModelSelection(environmentId);
  const { selectAgent } = useSelectedAgent();
  const mode = agentEditorMode(agent);
  const [draft, setDraft] = useState<AgentEditorDraft>(() => initialAgentEditorDraft(agent));
  const [touched, setTouched] = useState({ name: false, role: false });
  const [pending, setPending] = useState<"save" | "archive" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const errors = agentEditorErrors(draft, mode);
  const submission = agentEditorSubmission({ agent, draft, modelSelection });
  const canSave =
    mode === "create"
      ? agentCommands.can.create
      : mode === "firstmate"
        ? firstmateCommands.can.setAppearance
        : agentCommands.can.update;
  const busy = pending !== null;
  const close = () => navigation.goBack();

  const edit = (patch: Partial<AgentEditorDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const save = async () => {
    if (busy || !canSave) return;
    if (submission.kind === "unchanged") return close();
    if (submission.kind === "invalid" || submission.kind === "no-model") return;
    setPending("save");
    setError(null);
    const fallback =
      mode === "create" ? "Could not create the agent." : "Could not save the agent.";
    if (submission.kind === "create") {
      const result = await agentCommands.create({ environmentId, input: submission.input });
      if (result._tag === "Success") {
        // The Work tab follows the agent that was just made.
        selectAgent(result.value.agent.id);
        return close();
      }
      setPending(null);
      if (!isAtomCommandInterrupted(result)) {
        setError(agentEditorFailureMessage(squashAtomCommandFailure(result), fallback));
      }
      return;
    }
    const result =
      submission.kind === "appearance"
        ? await firstmateCommands.setAppearance({ environmentId, input: submission.input })
        : await agentCommands.update({ environmentId, input: submission.input });
    if (result._tag === "Success") return close();
    setPending(null);
    if (!isAtomCommandInterrupted(result)) {
      setError(agentEditorFailureMessage(squashAtomCommandFailure(result), fallback));
    }
  };

  const archive = () => {
    if (agent === null || mode !== "custom" || busy) return;
    Dialog.confirm({
      title: `Archive ${agent.name}?`,
      message: "The agent leaves the Work tab. Its chat, folder, and tasks stay on the server.",
      confirmText: "Archive",
      destructive: true,
      onConfirm: () => {
        setPending("archive");
        setError(null);
        void agentCommands
          .archive({ environmentId, input: { agentId: agent.id } })
          .then((result) => {
            if (result._tag === "Success") {
              // No explicit choice, as on web: the selection falls back by its own rules.
              selectAgent(null);
              // A split view's detail column drops the archived agent's chat or task.
              const routes = navigation.getState()?.routes ?? [];
              if (!stackShowsAgent(routes, agent)) return close();
              if (Platform.OS === "android") return resetAndroidWorkspace(navigation);
              return navigation.dispatch(StackActions.popToTop());
            }
            setPending(null);
            if (!isAtomCommandInterrupted(result)) {
              setError(
                agentEditorFailureMessage(
                  squashAtomCommandFailure(result),
                  `Could not archive ${agent.name}.`,
                ),
              );
            }
          });
      },
    });
  };

  const notice = !canSave
    ? "This connection can't change agents."
    : submission.kind === "no-model"
      ? "No provider can start a chat yet. Check the environment's providers."
      : null;

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      <SheetHeader
        presentation={Platform.OS === "android" ? "inline" : "native"}
        title={
          mode === "create" ? "New agent" : mode === "firstmate" ? "Name and icon" : "Edit agent"
        }
        onCancel={close}
        dismissDisabled={busy}
        confirm={{
          label: mode === "create" ? "Create and start" : "Save",
          onPress: () => void save(),
          disabled:
            !canSave || busy || submission.kind === "invalid" || submission.kind === "no-model",
          loading: pending === "save",
        }}
      />
      <ScrollView
        nestedScrollEnabled
        contentInsetAdjustmentBehavior="automatic"
        className="android:shrink android:grow-0 ios:flex-1"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <AppText className="text-sm text-foreground-muted">
          {mode === "create"
            ? "An agent is a chat with its own task board. Its role becomes the top of its instructions."
            : mode === "firstmate"
              ? "Shown on the Work tab and in the Tasks panel. The chat is renamed too."
              : "The role is rewritten at the top of the agent's instructions. The chat is renamed too."}
        </AppText>
        {error !== null ? <ErrorBanner message={error} /> : null}
        {notice !== null ? <ErrorBanner message={notice} /> : null}
        <View className="flex-row items-center gap-3">
          <AgentAvatar
            icon={draft.icon}
            color={draft.color}
            size={52}
            environmentId={environmentId}
            avatarAttachmentId={agent?.avatarAttachmentId}
          />
          <EditorField
            label="Name"
            error={touched.name ? errors.name : null}
            className="flex-1"
            value={draft.name}
            maxLength={AGENT_NAME_MAX_LENGTH}
            autoFocus={mode === "create"}
            autoCorrect={false}
            autoComplete="off"
            placeholder="Growth Lead"
            editable={!busy}
            returnKeyType={mode === "firstmate" ? "done" : "next"}
            onChangeText={(name) => {
              setTouched((current) => ({ ...current, name: true }));
              edit({ name });
            }}
          />
        </View>
        {mode === "firstmate" ? null : (
          <EditorField
            label="Role"
            error={touched.role ? errors.role : null}
            value={draft.role}
            maxLength={AGENT_ROLE_MAX_LENGTH}
            multiline
            textAlignVertical="top"
            inputClassName="min-h-28"
            placeholder="You run growth: affiliate partnerships, outreach, and reporting."
            editable={!busy}
            onChangeText={(role) => {
              setTouched((current) => ({ ...current, role: true }));
              edit({ role });
            }}
          />
        )}
        <View className="gap-2">
          <FieldLabel label="Icon" />
          <AgentEditorIconGrid
            value={draft.icon}
            color={draft.color}
            disabled={busy}
            onChange={(icon) => edit({ icon })}
          />
        </View>
        {mode === "firstmate" ? null : (
          <View className="gap-2">
            <FieldLabel label="Color" />
            <AgentEditorColorPicker
              value={draft.color}
              disabled={busy}
              onChange={(color) => edit({ color })}
            />
          </View>
        )}
        {mode === "custom" && agentCommands.can.archive ? (
          <Button
            label="Archive agent"
            icon="archivebox"
            tone="danger"
            loading={pending === "archive"}
            disabled={busy}
            onPress={archive}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function FieldLabel(props: { readonly label: string }) {
  return (
    <AppText
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted"
    >
      {props.label}
    </AppText>
  );
}

function EditorField({
  label,
  error,
  className,
  inputClassName,
  ...inputProps
}: Omit<AppTextInputProps, "accessibilityLabel" | "className"> & {
  readonly label: string;
  readonly error: string | null;
  readonly className?: string;
  readonly inputClassName?: string;
}) {
  return (
    <View collapsable={false} className={cn("gap-1.5", className)}>
      <FieldLabel label={label} />
      <AppTextInput
        {...inputProps}
        accessibilityLabel={label}
        accessibilityHint={error ?? undefined}
        className={cn("rounded-[14px] bg-subtle px-4 py-3.5 text-base", inputClassName)}
      />
      {error !== null ? (
        <AppText className="text-xs text-danger-foreground">{error}</AppText>
      ) : null}
    </View>
  );
}

function MissingAgent(props: { readonly loading: boolean }) {
  const navigation = useNavigation();
  return (
    <View collapsable={false} className="bg-sheet ios:flex-1">
      <SheetHeader
        presentation={Platform.OS === "android" ? "inline" : "native"}
        title="Edit agent"
        onClose={() => navigation.goBack()}
      />
      <View className="items-center justify-center gap-3 px-5 py-12">
        {props.loading ? (
          <AppActivityIndicator colorClassName="accent-foreground-muted" />
        ) : (
          <AppText className="text-center text-sm text-foreground-muted">
            This agent was archived or is on an environment that isn't connected.
          </AppText>
        )}
      </View>
    </View>
  );
}
