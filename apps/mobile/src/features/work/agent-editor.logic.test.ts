import {
  AgentProfileId,
  FIRSTMATE_AGENT_ID,
  type AgentProfile,
  type ModelSelection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_EDITOR_COLORS,
  agentEditorErrors,
  agentEditorFailureMessage,
  agentEditorMode,
  agentEditorSubmission,
  stackShowsAgent,
  initialAgentEditorDraft,
} from "./agent-editor.logic";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "default",
} as ModelSelection;

const growth = {
  id: AgentProfileId.make("growth"),
  slug: "growth",
  name: "Growth Lead",
  icon: "rocket",
  color: "emerald",
  role: "You run growth.",
  coordinatorThreadId: null,
  homeProjectId: null,
  modelSelection: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  archivedAt: null,
} as AgentProfile;

const firstmate = {
  ...growth,
  id: FIRSTMATE_AGENT_ID,
  slug: "firstmate",
  name: "Firstmate",
  icon: "compass",
  color: "sky",
  role: "",
} as AgentProfile;

describe("agent editor", () => {
  it("starts a new agent with the default icon and color", () => {
    expect(agentEditorMode(null)).toBe("create");
    expect(initialAgentEditorDraft(null)).toEqual({
      name: "",
      role: "",
      icon: "bot",
      color: "sky",
    });
    expect(AGENT_EDITOR_COLORS[0]).toEqual({ value: "gray", label: "Gray" });
  });

  it("requires a name, and a role for every agent except Firstmate", () => {
    const blank = { ...initialAgentEditorDraft(null), name: "  ", role: " " };
    expect(agentEditorErrors(blank, "create")).toEqual({
      name: "Enter a name.",
      role: "Describe what the agent does.",
    });
    expect(agentEditorErrors(blank, "firstmate").role).toBeNull();
    expect(agentEditorErrors({ ...blank, name: "x".repeat(61), role: "ok" }, "custom")).toEqual({
      name: "Use 60 characters or fewer.",
      role: null,
    });
    expect(agentEditorErrors({ ...blank, name: "ok", role: "x".repeat(2001) }, "custom").role).toBe(
      "Use 2000 characters or fewer.",
    );
  });

  it("creates with trimmed fields once a model is known", () => {
    const draft = {
      ...initialAgentEditorDraft(null),
      name: " Growth Lead ",
      role: " You run growth. ",
    };
    expect(agentEditorSubmission({ agent: null, draft, modelSelection: null })).toEqual({
      kind: "no-model",
    });
    expect(agentEditorSubmission({ agent: null, draft, modelSelection })).toEqual({
      kind: "create",
      input: {
        name: "Growth Lead",
        role: "You run growth.",
        icon: "bot",
        color: "sky",
        modelSelection,
      },
    });
    expect(
      agentEditorSubmission({ agent: null, draft: { ...draft, role: "" }, modelSelection }),
    ).toEqual({ kind: "invalid" });
  });

  it("updates only the fields that changed", () => {
    const draft = initialAgentEditorDraft(growth);
    expect(agentEditorMode(growth)).toBe("custom");
    expect(agentEditorSubmission({ agent: growth, draft, modelSelection: null })).toEqual({
      kind: "unchanged",
    });
    expect(
      agentEditorSubmission({
        agent: growth,
        draft: { ...draft, name: "Growth ", color: "rose" },
        modelSelection: null,
      }),
    ).toEqual({ kind: "update", input: { agentId: growth.id, name: "Growth", color: "rose" } });
  });

  it("leaves an unknown stored icon alone until a new one is picked", () => {
    const agent = { ...growth, icon: "future-icon" } as AgentProfile;
    const draft = initialAgentEditorDraft(agent);
    expect(draft.icon).toBe("compass");
    expect(agentEditorSubmission({ agent, draft, modelSelection: null })).toEqual({
      kind: "unchanged",
    });
  });

  it("saves Firstmate's name and icon through its appearance", () => {
    const draft = initialAgentEditorDraft(firstmate);
    expect(agentEditorMode(firstmate)).toBe("firstmate");
    expect(agentEditorSubmission({ agent: firstmate, draft, modelSelection: null })).toEqual({
      kind: "unchanged",
    });
    expect(
      agentEditorSubmission({
        agent: firstmate,
        draft: { ...draft, icon: "anchor" },
        modelSelection: null,
      }),
    ).toEqual({ kind: "appearance", input: { name: "Firstmate", icon: "anchor" } });
  });

  it("explains a failure with its message or the fallback", () => {
    expect(agentEditorFailureMessage(new Error("Name taken"), "Could not save")).toBe("Name taken");
    expect(agentEditorFailureMessage({ reason: "?" }, "Could not save")).toBe("Could not save");
  });
});

describe("stackShowsAgent", () => {
  const scout = { id: AgentProfileId.make("scout"), coordinatorThreadId: "scout-chat" } as Pick<
    AgentProfile,
    "id" | "coordinatorThreadId"
  >;

  it("finds the agent's coordinator chat or one of its tasks", () => {
    expect(
      stackShowsAgent(
        [{ name: "Home" }, { name: "Thread", params: { threadId: "scout-chat" } }],
        scout,
      ),
    ).toBe(true);
    expect(
      stackShowsAgent([{ name: "WorkTask", params: { taskId: "t", agentId: "scout" } }], scout),
    ).toBe(true);
  });

  it("ignores other chats and other agents' tasks", () => {
    expect(stackShowsAgent([{ name: "Thread", params: { threadId: "plain" } }], scout)).toBe(false);
    expect(stackShowsAgent([{ name: "WorkTask", params: { taskId: "t" } }], scout)).toBe(false);
  });
});
