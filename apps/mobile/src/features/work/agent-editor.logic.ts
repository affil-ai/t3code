/**
 * The agent editor's form rules: what a draft starts as, which fields it
 * may change, what is wrong with it, and which command saving it runs.
 * Firstmate is edited through `firstmate.setAppearance` (name and icon only);
 * custom agents through `agents.create` and `agents.update`.
 */
import {
  type FirstmateIconKey,
  resolveFirstmateIconKey,
} from "@t3tools/client-runtime/firstmate/icons";
import {
  AGENT_DEFAULT_COLOR,
  AGENT_DEFAULT_ICON,
  type AgentCreateInput,
  type AgentProfile,
  type AgentUpdateInput,
  FIRSTMATE_AGENT_ID,
  type FirstmateSetAppearanceInput,
  type ModelSelection,
  ProjectIconColor,
} from "@t3tools/contracts";

export const AGENT_NAME_MAX_LENGTH = 60;
export const AGENT_ROLE_MAX_LENGTH = 2000;

/** The project icon palette in picker order, as on web. */
export const AGENT_EDITOR_COLORS: ReadonlyArray<{
  readonly value: ProjectIconColor;
  readonly label: string;
}> = ProjectIconColor.literals.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

/** `create` makes a new agent; Firstmate only takes a name and an icon. */
export type AgentEditorMode = "create" | "custom" | "firstmate";

export interface AgentEditorDraft {
  readonly name: string;
  readonly role: string;
  readonly icon: FirstmateIconKey;
  readonly color: ProjectIconColor;
}

export interface AgentEditorErrors {
  readonly name: string | null;
  readonly role: string | null;
}

export type AgentEditorSubmission =
  | { readonly kind: "invalid" }
  | { readonly kind: "unchanged" }
  /** Creating waits for the default model; none can run a chat yet. */
  | { readonly kind: "no-model" }
  | { readonly kind: "create"; readonly input: AgentCreateInput }
  | { readonly kind: "update"; readonly input: AgentUpdateInput }
  | { readonly kind: "appearance"; readonly input: FirstmateSetAppearanceInput };

export function agentEditorMode(agent: Pick<AgentProfile, "id"> | null): AgentEditorMode {
  if (agent === null) return "create";
  return agent.id === FIRSTMATE_AGENT_ID ? "firstmate" : "custom";
}

export function initialAgentEditorDraft(
  agent: Pick<AgentProfile, "name" | "role" | "icon" | "color"> | null,
): AgentEditorDraft {
  return {
    name: agent?.name ?? "",
    role: agent?.role ?? "",
    icon: resolveFirstmateIconKey(agent?.icon ?? AGENT_DEFAULT_ICON),
    color: agent?.color ?? AGENT_DEFAULT_COLOR,
  };
}

/** Field errors, matching the server's limits. Firstmate has no role to check. */
export function agentEditorErrors(
  draft: AgentEditorDraft,
  mode: AgentEditorMode,
): AgentEditorErrors {
  const name = draft.name.trim();
  const role = draft.role.trim();
  return {
    name:
      name.length === 0
        ? "Enter a name."
        : name.length > AGENT_NAME_MAX_LENGTH
          ? `Use ${AGENT_NAME_MAX_LENGTH} characters or fewer.`
          : null,
    role:
      mode === "firstmate"
        ? null
        : role.length === 0
          ? "Describe what the agent does."
          : role.length > AGENT_ROLE_MAX_LENGTH
            ? `Use ${AGENT_ROLE_MAX_LENGTH} characters or fewer.`
            : null,
  };
}

/**
 * What saving the draft does. Edits send only the fields that differ from the
 * agent as it opened, so an unknown stored icon is not overwritten unless the
 * user picks a new one.
 */
export function agentEditorSubmission(input: {
  readonly agent: AgentProfile | null;
  readonly draft: AgentEditorDraft;
  readonly modelSelection: ModelSelection | null;
}): AgentEditorSubmission {
  const { agent, draft } = input;
  const mode = agentEditorMode(agent);
  const errors = agentEditorErrors(draft, mode);
  if (errors.name !== null || errors.role !== null) return { kind: "invalid" };
  const name = draft.name.trim();
  const role = draft.role.trim();

  if (agent === null) {
    if (input.modelSelection === null) return { kind: "no-model" };
    return {
      kind: "create",
      input: {
        name,
        role,
        icon: draft.icon,
        color: draft.color,
        modelSelection: input.modelSelection,
      },
    };
  }

  const initial = initialAgentEditorDraft(agent);
  const nameChanged = name !== initial.name;
  const iconChanged = draft.icon !== initial.icon;
  if (mode === "firstmate") {
    if (!nameChanged && !iconChanged) return { kind: "unchanged" };
    // setAppearance replaces both, so an untouched unknown icon is sent back as stored.
    return {
      kind: "appearance",
      input: { name, icon: iconChanged ? draft.icon : agent.icon },
    };
  }

  const changes = {
    ...(nameChanged ? { name } : {}),
    ...(role === initial.role ? {} : { role }),
    ...(iconChanged ? { icon: draft.icon } : {}),
    ...(draft.color === initial.color ? {} : { color: draft.color }),
  };
  if (Object.keys(changes).length === 0) return { kind: "unchanged" };
  return { kind: "update", input: { agentId: agent.id, ...changes } };
}

/** A failed save's message for the form, falling back when the cause has none. */
export function agentEditorFailureMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  return fallback;
}

/**
 * Whether a navigation stack shows something of the agent: its coordinator
 * chat or one of its tasks. Archiving the agent clears those, so a split
 * view's detail column does not keep an agent that left the Work tab.
 */
export function stackShowsAgent(
  routes: ReadonlyArray<{ readonly name: string; readonly params?: object | undefined }>,
  agent: Pick<AgentProfile, "id" | "coordinatorThreadId">,
): boolean {
  return routes.some((route) => {
    const params = route.params as Readonly<Record<string, unknown>> | undefined;
    if (route.name === "WorkTask") return params?.agentId === agent.id;
    return (
      route.name === "Thread" &&
      agent.coordinatorThreadId !== null &&
      params?.threadId === agent.coordinatorThreadId
    );
  });
}
