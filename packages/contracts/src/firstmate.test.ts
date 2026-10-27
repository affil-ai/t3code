import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FIRSTMATE_CLIENT_GUARDED_RPC_SCOPES,
  FIRSTMATE_RPC_REQUIRED_SCOPES,
  FIRSTMATE_WS_METHODS,
  FirstmateConfig,
  FirstmateGetTaskInput,
  FirstmateRpcs,
  FirstmateSetAppearanceInput,
  FirstmateSetCoordinatorInput,
  FirstmateSnapshot,
  FirstmateStartInput,
  FirstmateStartResult,
  FirstmateStoredTask,
  FirstmateTask,
  FirstmateTaskCreateInput,
  FirstmateTaskEvent,
  FirstmateTaskId,
  FirstmateTaskListInput,
  FirstmateTaskReportProgressInput,
  FirstmateTaskUpdateInput,
  firstmateStateForStatus,
  AgentProfile,
  AgentUpdateInput,
} from "./firstmate.ts";
import { WsRpcGroup } from "./rpc.ts";

const task = {
  id: "firstmate-task:1",
  title: "Deliver the report",
  intent: "  Please deliver the report.\n",
  definitionOfDone: "The report has been delivered.",
  state: "open",
  nextActor: "coordinator",
  note: "",
  wakeAt: null,
  workerThreadId: null,
  links: [],
  closeEvidence: null,
  createdAt: "2026-10-12T10:00:00.000Z",
  updatedAt: "2026-10-12T10:00:00.000Z",
  closedAt: null,
} as const;

const decodeCreate = Schema.decodeUnknownSync(FirstmateTaskCreateInput);
const decodeStored = Schema.decodeUnknownSync(FirstmateStoredTask);
const decodeId = Schema.decodeUnknownSync(FirstmateTaskId);
const decodeUpdate = Schema.decodeUnknownSync(FirstmateTaskUpdateInput);
const decodeTask = Schema.decodeUnknownSync(FirstmateTask);
const decodeEvent = Schema.decodeUnknownSync(FirstmateTaskEvent);
const decodeList = Schema.decodeUnknownSync(FirstmateTaskListInput);
const decodeGetTask = Schema.decodeUnknownSync(FirstmateGetTaskInput);
const decodeSetCoordinator = Schema.decodeUnknownSync(FirstmateSetCoordinatorInput);
const decodeConfig = Schema.decodeUnknownSync(FirstmateConfig);
const decodeAppearance = Schema.decodeUnknownSync(FirstmateSetAppearanceInput);
const decodeSnapshot = Schema.decodeUnknownSync(FirstmateSnapshot);
const decodeStartInput = Schema.decodeUnknownSync(FirstmateStartInput);
const decodeStart = Schema.decodeUnknownSync(FirstmateStartResult);

describe("Firstmate task contracts", () => {
  it("decodes legacy agents and preserves explicit avatar removal versus an omitted edit", () => {
    const legacy = {
      id: "agent:money",
      slug: "money",
      name: "Money Maker",
      icon: "dollar-sign",
      color: "green",
      role: "Track spending.",
      coordinatorThreadId: null,
      homeProjectId: null,
      modelSelection: null,
      createdAt: "2026-10-19T10:00:00.000Z",
      archivedAt: null,
    };
    const decodeAgent = Schema.decodeUnknownSync(AgentProfile);
    expect(decodeAgent(legacy)).toEqual(legacy);
    expect(decodeAgent({ ...legacy, avatarAttachmentId: "avatar-1" }).avatarAttachmentId).toBe(
      "avatar-1",
    );
    const decodeAgentUpdate = Schema.decodeUnknownSync(AgentUpdateInput);
    expect(decodeAgentUpdate({ agentId: legacy.id, icon: "wallet" })).not.toHaveProperty(
      "avatarAttachmentId",
    );
    expect(decodeAgentUpdate({ agentId: legacy.id, avatarAttachmentId: null })).toMatchObject({
      avatarAttachmentId: null,
    });
  });
  it("uses a non-blank branded task ID", () => {
    expect(decodeId("  firstmate-task:1  ")).toBe("firstmate-task:1");
    expect(() => decodeId(" \n ")).toThrow();
  });

  it("preserves user intent verbatim when creating a task", () => {
    const input = {
      title: " Deliver the report ",
      intent: task.intent,
      definitionOfDone: task.definitionOfDone,
    };
    expect(decodeCreate(input)).toEqual({ ...input, title: "Deliver the report" });
    expect(() => decodeCreate({ ...input, intent: " \n " })).toThrow();
  });

  it("leaves create defaults to the service rather than inventing fields", () => {
    expect(
      decodeCreate({
        title: task.title,
        intent: task.intent,
        definitionOfDone: task.definitionOfDone,
      }),
    ).toEqual({
      title: task.title,
      intent: task.intent,
      definitionOfDone: task.definitionOfDone,
    });
  });

  it("supports event-only updates and explicit clearing of nullable fields", () => {
    expect(decodeUpdate({ taskId: task.id, summary: "Checked worker progress." })).toEqual({
      taskId: task.id,
      summary: "Checked worker progress.",
    });
    expect(
      decodeUpdate({
        taskId: task.id,
        summary: "Cleared the old worker and wake.",
        wakeAt: null,
        workerThreadId: null,
        closeEvidence: null,
      }),
    ).toEqual({
      taskId: task.id,
      summary: "Cleared the old worker and wake.",
      wakeAt: null,
      workerThreadId: null,
      closeEvidence: null,
    });
  });

  it("requires a non-blank event summary for every update", () => {
    expect(() => decodeUpdate({ taskId: task.id, note: "Checked." })).toThrow();
    expect(() => decodeUpdate({ taskId: task.id, summary: " \n " })).toThrow();
  });

  it.each(["done", "dropped"] as const)("requires close evidence for %s", (state) => {
    const input = { taskId: task.id, summary: "Closed the task.", state };
    expect(() => decodeUpdate(input)).toThrow();
    expect(() => decodeUpdate({ ...input, closeEvidence: null })).toThrow();
    expect(() => decodeUpdate({ ...input, closeEvidence: " \n " })).toThrow();
    expect(decodeUpdate({ ...input, closeEvidence: "The user accepted the report." })).toEqual({
      ...input,
      closeEvidence: "The user accepted the report.",
    });
  });

  it("does not require close evidence for non-closing state changes", () => {
    expect(
      decodeUpdate({ taskId: task.id, summary: "Waiting for the user.", state: "waiting" }),
    ).toEqual({ taskId: task.id, summary: "Waiting for the user.", state: "waiting" });
  });

  it("accepts ready as an update state without close evidence", () => {
    expect(
      decodeUpdate({ taskId: task.id, summary: "Reviewed and green.", state: "ready" }),
    ).toEqual({
      taskId: task.id,
      summary: "Reviewed and green.",
      state: "ready",
    });
  });

  it("keeps reactor bookkeeping out of the public task model", () => {
    const stored = decodeStored({
      ...task,
      lastReportedRunId: "run:1",
      orphanNotifiedAt: "2026-10-12T10:30:00.000Z",
    });
    expect(decodeTask(stored)).toEqual(task);
  });

  it("requires valid task states, next actors, and event actors", () => {
    expect(() => decodeTask({ ...task, state: "running" })).toThrow();
    expect(() => decodeTask({ ...task, nextActor: "system" })).toThrow();
    const event = {
      id: "firstmate-event:1",
      taskId: task.id,
      createdAt: task.createdAt,
      actor: "system",
      summary: "Worker finished.",
    };
    expect(decodeEvent(event)).toEqual(event);
    expect(() => decodeEvent({ ...event, actor: "worker" })).toThrow();
  });

  it("offers state filtering while leaving the unclosed default to the service", () => {
    expect(decodeList({})).toEqual({});
    expect(decodeList({ state: "dropped" })).toEqual({ state: "dropped" });
    expect(() => decodeList({ state: "closed" })).toThrow();
  });

  it("can produce JSON schemas for MCP create and update inputs", () => {
    expect(Schema.toJsonSchemaDocument(FirstmateTaskCreateInput).schema).toMatchObject({
      type: "object",
      required: ["title", "intent", "definitionOfDone"],
    });
    expect(Schema.toJsonSchemaDocument(FirstmateTaskUpdateInput).schema).toMatchObject({
      type: "object",
      required: ["taskId", "summary"],
    });
  });
});

describe("Firstmate task progress", () => {
  const decodeReport = Schema.decodeUnknownSync(FirstmateTaskReportProgressInput);
  const metric = {
    label: "Recall",
    kind: "metric",
    value: 87.5,
    baseline: 72,
    target: 90,
    unit: "%",
    direction: "higher",
  } as const;

  it("accepts a metric or a count, with only label, kind, and value required", () => {
    expect(decodeReport({ progress: metric })).toEqual({ progress: metric });
    expect(
      decodeReport({
        taskId: "firstmate-task:1",
        progress: { label: "Hotels", kind: "count", value: 1611 },
      }),
    ).toMatchObject({ taskId: "firstmate-task:1", progress: { kind: "count", value: 1611 } });
  });

  it("rejects malformed values and any field besides taskId and progress", () => {
    expect(() => decodeReport({ progress: { ...metric, value: Number.NaN } })).toThrow();
    expect(() => decodeReport({ progress: { ...metric, value: "87.5" } })).toThrow();
    expect(() => decodeReport({ progress: { ...metric, kind: "percent" } })).toThrow();
    expect(() => decodeReport({ progress: { ...metric, direction: "up" } })).toThrow();
    expect(() => decodeReport({ progress: { ...metric, label: " " } })).toThrow();
    expect(() => decodeReport({ progress: { ...metric, unit: "x".repeat(17) } })).toThrow();
    expect(() => decodeReport({ progress: metric, title: "(88%) Recall" })).toThrow();
    expect(() => decodeReport({ progress: metric, status: "done" })).toThrow();
    expect(() => decodeReport({ progress: { ...metric, updatedAt: task.createdAt } })).toThrow();
  });

  it("lets a coordinator set or clear progress on update, and old tasks decode without it", () => {
    expect(
      decodeUpdate({ taskId: "firstmate-task:1", summary: "Baseline", progress: metric }),
    ).toMatchObject({
      progress: metric,
    });
    expect(
      decodeUpdate({ taskId: "firstmate-task:1", summary: "Reset", progress: null }).progress,
    ).toBeNull();
    expect(decodeTask(task).progress).toBeUndefined();
    const stored = {
      ...metric,
      updatedAt: task.createdAt,
      history: [{ value: 87.5, at: task.createdAt }],
    };
    expect(decodeTask({ ...task, progress: stored }).progress).toEqual(stored);
  });

  it("adds hillclimb as an open status that creates and updates accept", () => {
    expect(firstmateStateForStatus("hillclimb")).toBe("open");
    expect(decodeTask({ ...task, status: "hillclimb" }).status).toBe("hillclimb");
    expect(decodeCreate({ ...task, status: "hillclimb" }).status).toBe("hillclimb");
    expect(
      decodeUpdate({ taskId: "firstmate-task:1", summary: "Climbing", status: "hillclimb" }).status,
    ).toBe("hillclimb");
  });
});

describe("Firstmate RPC contracts", () => {
  it("registers every feature method with the shared RPC group", () => {
    expect(FirstmateRpcs.map((rpc) => rpc._tag)).toEqual(Object.values(FIRSTMATE_WS_METHODS));
    for (const method of Object.values(FIRSTMATE_WS_METHODS)) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
  });

  it("accepts both setting and clearing the coordinator", () => {
    expect(decodeSetCoordinator({ threadId: "thread:1" })).toEqual({ threadId: "thread:1" });
    expect(decodeSetCoordinator({ threadId: null })).toEqual({ threadId: null });
    expect(() => decodeSetCoordinator({})).toThrow();
    const config = { coordinatorThreadId: null, name: "Firstmate", icon: "compass" };
    expect(decodeConfig(config)).toEqual(config);
  });

  it("uses taskId for shared RPC and MCP lookups", () => {
    expect(decodeGetTask({ taskId: task.id })).toEqual({
      taskId: task.id,
    });
    expect(() => decodeGetTask({ id: task.id })).toThrow();
  });

  it("streams forward-compatible snapshots and returns the new thread from start", () => {
    const snapshot = {
      coordinatorThreadId: "thread:1",
      name: "Firstmate",
      icon: "compass",
      tasks: [task],
    };
    expect(
      decodeSnapshot({
        ...snapshot,
        tasks: [task, { ...task, id: "future-task", state: "future-state" }],
      }),
    ).toEqual(snapshot);
    expect(decodeStart({ threadId: "thread:1", snapshot })).toEqual({
      threadId: "thread:1",
      snapshot,
    });
  });

  it("sets a trimmed name and any short icon key, leaving unknown icons to the client", () => {
    expect(decodeAppearance({ name: "  Jarvis ", icon: "rocket" })).toEqual({
      name: "Jarvis",
      icon: "rocket",
    });
    // An icon a newer client added still decodes; older clients draw the compass.
    expect(decodeAppearance({ name: "Jarvis", icon: "future-icon" }).icon).toBe("future-icon");
    expect(() => decodeAppearance({ name: " ", icon: "rocket" })).toThrow();
    expect(() => decodeAppearance({ name: "Jarvis", icon: "" })).toThrow();
    expect(() => decodeAppearance({ name: "x".repeat(61), icon: "rocket" })).toThrow();
    expect(() => decodeAppearance({ name: "Jarvis" })).toThrow();
  });

  it("starts from a model selection alone, with no project", () => {
    const modelSelection = { instanceId: "codex", model: "gpt-5" };
    expect(decodeStartInput({ modelSelection })).toEqual({ modelSelection });
    expect(() => decodeStartInput({})).toThrow();
    expect(() => decodeStartInput({ projectId: "project:1" })).toThrow();
  });

  it("declares read scopes for reads and operate scopes for mutations", () => {
    expect(FIRSTMATE_RPC_REQUIRED_SCOPES).toEqual({
      "firstmate.setTaskPriority": "orchestration:operate",
      "firstmate.subscribe": "orchestration:read",
      "firstmate.getTask": "orchestration:read",
      "firstmate.setCoordinator": "orchestration:operate",
      "firstmate.start": "orchestration:operate",
      "firstmate.setAppearance": "orchestration:operate",
      "agents.subscribe": "orchestration:read",
      "agents.tasks.subscribe": "orchestration:read",
      "agents.create": "orchestration:operate",
      "agents.update": "orchestration:operate",
      "agents.archive": "orchestration:operate",
      "agents.start": "orchestration:operate",
      "standup.subscribe": "orchestration:read",
    });
    expect(FIRSTMATE_CLIENT_GUARDED_RPC_SCOPES).toEqual({
      "firstmate.setTaskPriority": "orchestration:operate",
      "firstmate.setCoordinator": "orchestration:operate",
      "firstmate.start": "orchestration:operate",
      "firstmate.setAppearance": "orchestration:operate",
      "agents.create": "orchestration:operate",
      "agents.update": "orchestration:operate",
      "agents.archive": "orchestration:operate",
      "agents.start": "orchestration:operate",
    });
  });
});
