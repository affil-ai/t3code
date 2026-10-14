import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectIconColor } from "./project.ts";

export const FirstmateTaskId = TrimmedNonEmptyString.pipe(Schema.brand("FirstmateTaskId"));
export type FirstmateTaskId = typeof FirstmateTaskId.Type;

export const FirstmateTaskEventId = TrimmedNonEmptyString.pipe(
  Schema.brand("FirstmateTaskEventId"),
);
export type FirstmateTaskEventId = typeof FirstmateTaskEventId.Type;

/**
 * `waiting` means in review: the work is ready and waits on reviewers (Devin,
 * the Office reviewer, a teammate) or on checks. The board shows it as
 * "In review".
 *
 * `ready` means reviewed with checks green, waiting only on the user to merge
 * or deploy. The board shows it as "Ready for deployment".
 */
export const FirstmateTaskState = Schema.Literals(["open", "waiting", "ready", "done", "dropped"]);
export type FirstmateTaskState = typeof FirstmateTaskState.Type;

export const FirstmateNextActor = Schema.Literals(["coordinator", "worker", "user", "external"]);
export type FirstmateNextActor = typeof FirstmateNextActor.Type;

export const FirstmateTaskEventActor = Schema.Literals(["coordinator", "user", "system"]);
export type FirstmateTaskEventActor = typeof FirstmateTaskEventActor.Type;

/** Preserve the user's request verbatim, including whitespace, while rejecting blank requests. */
const FirstmateIntent = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0, {
    expected: "a non-blank user request",
    toJsonSchema: () => [{ minLength: 1 }, true],
  }),
);

export const FirstmateTaskLink = Schema.Struct({
  label: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type FirstmateTaskLink = typeof FirstmateTaskLink.Type;

/**
 * Something the user should look at to review a task: a link (PR, preview,
 * deck) or an image (a screenshot). An image's `url` is an absolute path on
 * the server; the server copies it into Firstmate's folder when it is added,
 * so it outlives the worker's worktree.
 */
export const FirstmateTaskArtifact = Schema.Struct({
  kind: Schema.Literals(["link", "image"]),
  label: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  /** One line on what to check, e.g. "the empty state". */
  caption: Schema.optional(Schema.String),
});
export type FirstmateTaskArtifact = typeof FirstmateTaskArtifact.Type;

/**
 * What happens next on a task, as a short imperative phrase that names the PR
 * or decision ("Approve merge of #4118"). The board shows it in place of who
 * acts next.
 */
export const FirstmateNextStep = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export type FirstmateNextStep = typeof FirstmateNextStep.Type;

const NEXT_STEP_DESCRIPTION =
  'What happens next, as a short imperative phrase (at most 80 characters) naming the PR or decision, e.g. "Approve merge of #4118" or "Worker fixing Office comment". Not a sentence about who acts.';

/** Public task model; reactor bookkeeping stays on the server. */
export const FirstmateTask = Schema.Struct({
  id: FirstmateTaskId,
  title: TrimmedNonEmptyString,
  intent: FirstmateIntent,
  definitionOfDone: TrimmedNonEmptyString,
  state: FirstmateTaskState,
  nextActor: FirstmateNextActor,
  /** Older servers omit it; read it as none. */
  nextStep: Schema.optional(Schema.NullOr(Schema.String)),
  note: Schema.String,
  wakeAt: Schema.NullOr(IsoDateTime),
  workerThreadId: Schema.NullOr(ThreadId),
  links: Schema.Array(FirstmateTaskLink),
  /** Older servers omit it; read it as empty. */
  artifacts: Schema.optional(Schema.Array(FirstmateTaskArtifact)),
  closeEvidence: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
});
export type FirstmateTask = typeof FirstmateTask.Type;

/** Store-only fields for deduplicating worker and orphan wakes. Never return them in snapshots. */
export const FirstmateStoredTask = Schema.Struct({
  ...FirstmateTask.fields,
  lastReportedRunId: Schema.NullOr(RunId),
  orphanNotifiedAt: Schema.NullOr(IsoDateTime),
});
export type FirstmateStoredTask = typeof FirstmateStoredTask.Type;

export const FirstmateTaskEvent = Schema.Struct({
  id: FirstmateTaskEventId,
  taskId: FirstmateTaskId,
  createdAt: IsoDateTime,
  actor: FirstmateTaskEventActor,
  summary: TrimmedNonEmptyString,
});
export type FirstmateTaskEvent = typeof FirstmateTaskEvent.Type;

/** What the app calls Firstmate, shown in the sidebar, the Tasks panel, and the chat title. */
export const FirstmateName = TrimmedNonEmptyString.check(Schema.isMaxLength(60));
export type FirstmateName = typeof FirstmateName.Type;

/**
 * A key from the web client's fixed icon set. The contract accepts any short
 * key so a newer icon never fails the board stream; clients draw unknown keys
 * as the default compass.
 */
export const FirstmateIcon = TrimmedNonEmptyString.check(Schema.isMaxLength(40));
export type FirstmateIcon = typeof FirstmateIcon.Type;

export const FIRSTMATE_DEFAULT_NAME = "Firstmate";
export const FIRSTMATE_DEFAULT_ICON = "compass";

export const FirstmateConfig = Schema.Struct({
  coordinatorThreadId: Schema.NullOr(ThreadId),
  /** The project rooted at Firstmate's home folder, once a start has made it. Older servers omit it. */
  homeProjectId: Schema.optional(Schema.NullOr(ProjectId)),
  name: FirstmateName,
  icon: FirstmateIcon,
});
export type FirstmateConfig = typeof FirstmateConfig.Type;

/**
 * An agent: one coordinator chat with its own task board, worker chats, and
 * wake-ups, running in its own folder of the shared `~/agents` repository.
 * Firstmate is the reserved agent `firstmate`; the others are created by the
 * user in Agents mode.
 */
export const AgentProfileId = TrimmedNonEmptyString.pipe(Schema.brand("AgentProfileId"));
export type AgentProfileId = typeof AgentProfileId.Type;

export const FIRSTMATE_AGENT_ID = AgentProfileId.make("firstmate");

/** Folder name under `agents/`: lowercase letters, digits, and dashes. */
export const AgentSlug = Schema.String.check(
  Schema.makeFilter((value: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(value), {
    expected: "a folder name of lowercase letters, digits, and dashes",
  }),
);
export type AgentSlug = typeof AgentSlug.Type;

/** One or two sentences that become the top of the agent's AGENTS.md. */
export const AgentRole = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));
export type AgentRole = typeof AgentRole.Type;

export const AGENT_DEFAULT_COLOR: ProjectIconColor = "sky";

export const AgentProfile = Schema.Struct({
  id: AgentProfileId,
  slug: AgentSlug,
  name: FirstmateName,
  icon: FirstmateIcon,
  color: ProjectIconColor,
  role: Schema.String,
  coordinatorThreadId: Schema.NullOr(ThreadId),
  homeProjectId: Schema.NullOr(ProjectId),
  /** The model the agent's chat was started with, when known. */
  modelSelection: Schema.NullOr(ModelSelection),
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type AgentProfile = typeof AgentProfile.Type;

export const AgentsSnapshot = Schema.Struct({
  agents: ForwardCompatibleArray(AgentProfile),
});
export type AgentsSnapshot = typeof AgentsSnapshot.Type;

export const FirstmateSnapshot = Schema.Struct({
  ...FirstmateConfig.fields,
  /** Whose board this is. Older servers omit it; read it as Firstmate's. */
  agentId: Schema.optional(AgentProfileId),
  // Like scheduled tasks, a newer task state must not fail the entire board stream.
  tasks: ForwardCompatibleArray(FirstmateTask),
});
export type FirstmateSnapshot = typeof FirstmateSnapshot.Type;

export const FirstmateTaskDetail = Schema.Struct({
  task: FirstmateTask,
  events: Schema.Array(FirstmateTaskEvent),
});
export type FirstmateTaskDetail = typeof FirstmateTaskDetail.Type;

export const FirstmateTaskListInput = Schema.Struct({
  state: Schema.optional(FirstmateTaskState).annotate({
    description: "Filter by state. Omit to list every task that is not done or dropped.",
  }),
});
export type FirstmateTaskListInput = typeof FirstmateTaskListInput.Type;

export const FirstmateTaskListResult = Schema.Struct({
  tasks: ForwardCompatibleArray(FirstmateTask),
});
export type FirstmateTaskListResult = typeof FirstmateTaskListResult.Type;

export const FirstmateTaskGetInput = Schema.Struct({
  taskId: FirstmateTaskId,
});
export type FirstmateTaskGetInput = typeof FirstmateTaskGetInput.Type;

/** The RPC and MCP get operations share the same payload and result. */
export const FirstmateGetTaskInput = FirstmateTaskGetInput;
export type FirstmateGetTaskInput = typeof FirstmateGetTaskInput.Type;
export const FirstmateTaskGetResult = FirstmateTaskDetail;
export type FirstmateTaskGetResult = typeof FirstmateTaskGetResult.Type;
export const FirstmateGetTaskResult = FirstmateTaskDetail;
export type FirstmateGetTaskResult = typeof FirstmateGetTaskResult.Type;

/** New tasks start open; persistence chooses IDs, timestamps, and the create event. */
export const FirstmateTaskCreateInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  intent: FirstmateIntent.annotate({ description: "The user's request in their own words." }),
  definitionOfDone: TrimmedNonEmptyString,
  nextActor: Schema.optional(FirstmateNextActor).annotate({
    description: "Who acts next. Omit for coordinator.",
  }),
  nextStep: Schema.optional(FirstmateNextStep).annotate({ description: NEXT_STEP_DESCRIPTION }),
  note: Schema.optional(Schema.String),
  wakeAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  workerThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  links: Schema.optional(Schema.Array(FirstmateTaskLink)),
  artifacts: Schema.optional(Schema.Array(FirstmateTaskArtifact)).annotate({
    description:
      "Review artifacts: links and screenshots the user should look at. Images take an absolute file path.",
  }),
  summary: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Summary for the create event. Omit for the default creation summary.",
  }),
});
export type FirstmateTaskCreateInput = typeof FirstmateTaskCreateInput.Type;

/** Omitted fields are unchanged. Explicit null clears nullable fields. */
export const FirstmateTaskUpdateInput = Schema.Struct({
  taskId: FirstmateTaskId,
  summary: TrimmedNonEmptyString.annotate({
    description: "Required summary for the append-only update event.",
  }),
  title: Schema.optional(TrimmedNonEmptyString),
  intent: Schema.optional(FirstmateIntent),
  definitionOfDone: Schema.optional(TrimmedNonEmptyString),
  state: Schema.optional(FirstmateTaskState),
  nextActor: Schema.optional(FirstmateNextActor),
  nextStep: Schema.optional(Schema.NullOr(FirstmateNextStep)).annotate({
    description: `${NEXT_STEP_DESCRIPTION} Write it whenever state or nextActor changes. Null clears it.`,
  }),
  note: Schema.optional(Schema.String),
  wakeAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  workerThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  links: Schema.optional(Schema.Array(FirstmateTaskLink)),
  artifacts: Schema.optional(Schema.Array(FirstmateTaskArtifact)).annotate({
    description:
      "Replaces all review artifacts. Review artifacts: links and screenshots the user should look at. Images take an absolute file path.",
  }),
  addArtifacts: Schema.optional(Schema.Array(FirstmateTaskArtifact)).annotate({
    description:
      "Appends review artifacts, after any replacement. Review artifacts: links and screenshots the user should look at. Images take an absolute file path.",
  }),
  closeEvidence: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).annotate({
    description: "Required when moving to done or dropped. Evidence of the outcome or decision.",
  }),
}).check(
  Schema.makeFilter(
    (input) => (input.state !== "done" && input.state !== "dropped") || input.closeEvidence != null,
    { expected: "closeEvidence when moving a task to done or dropped" },
  ),
);
export type FirstmateTaskUpdateInput = typeof FirstmateTaskUpdateInput.Type;

export const FirstmateTaskMutationResult = Schema.Struct({
  task: FirstmateTask,
});
export type FirstmateTaskMutationResult = typeof FirstmateTaskMutationResult.Type;
export const FirstmateTaskCreateResult = FirstmateTaskMutationResult;
export type FirstmateTaskCreateResult = typeof FirstmateTaskCreateResult.Type;
export const FirstmateTaskUpdateResult = FirstmateTaskMutationResult;
export type FirstmateTaskUpdateResult = typeof FirstmateTaskUpdateResult.Type;

export const FirstmateSubscribeInput = Schema.Struct({});
export type FirstmateSubscribeInput = typeof FirstmateSubscribeInput.Type;

export const FirstmateSetCoordinatorInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
});
export type FirstmateSetCoordinatorInput = typeof FirstmateSetCoordinatorInput.Type;

export const FirstmateSetCoordinatorResult = FirstmateSnapshot;
export type FirstmateSetCoordinatorResult = typeof FirstmateSetCoordinatorResult.Type;

/** Renames Firstmate and its coordinator chat, and sets its icon. */
export const FirstmateSetAppearanceInput = Schema.Struct({
  name: FirstmateName,
  icon: FirstmateIcon,
});
export type FirstmateSetAppearanceInput = typeof FirstmateSetAppearanceInput.Type;

export const FirstmateSetAppearanceResult = FirstmateSnapshot;
export type FirstmateSetAppearanceResult = typeof FirstmateSetAppearanceResult.Type;

/** The coordinator starts at the root of Firstmate's home project; the client picks the model. */
export const FirstmateStartInput = Schema.Struct({
  modelSelection: ModelSelection,
});
export type FirstmateStartInput = typeof FirstmateStartInput.Type;

export const FirstmateStartResult = Schema.Struct({
  threadId: ThreadId,
  snapshot: FirstmateSnapshot,
});
export type FirstmateStartResult = typeof FirstmateStartResult.Type;

export const AgentsSubscribeInput = Schema.Struct({});
export type AgentsSubscribeInput = typeof AgentsSubscribeInput.Type;

/** The agent's board stream, shaped like Firstmate's. */
export const AgentTasksSubscribeInput = Schema.Struct({
  agentId: AgentProfileId,
});
export type AgentTasksSubscribeInput = typeof AgentTasksSubscribeInput.Type;

/** Creating an agent seeds its folder and starts its chat with `modelSelection`. */
export const AgentCreateInput = Schema.Struct({
  name: FirstmateName,
  role: AgentRole,
  icon: FirstmateIcon,
  color: ProjectIconColor,
  modelSelection: ModelSelection,
});
export type AgentCreateInput = typeof AgentCreateInput.Type;

export const AgentCreateResult = Schema.Struct({
  agent: AgentProfile,
  threadId: ThreadId,
});
export type AgentCreateResult = typeof AgentCreateResult.Type;

/** Omitted fields are unchanged. A new role rewrites the top of the agent's AGENTS.md. */
export const AgentUpdateInput = Schema.Struct({
  agentId: AgentProfileId,
  name: Schema.optional(FirstmateName),
  icon: Schema.optional(FirstmateIcon),
  color: Schema.optional(ProjectIconColor),
  role: Schema.optional(AgentRole),
});
export type AgentUpdateInput = typeof AgentUpdateInput.Type;

// --- agent MCP tools -------------------------------------------------------

export const AgentListToolResult = Schema.Struct({
  agents: ForwardCompatibleArray(AgentProfile),
});
export type AgentListToolResult = typeof AgentListToolResult.Type;

export const AgentTasksToolInput = Schema.Struct({
  agentId: AgentProfileId,
  state: Schema.optional(FirstmateTaskState).annotate({
    description: "Filter by state. Omit to list every task that is not done or dropped.",
  }),
});
export type AgentTasksToolInput = typeof AgentTasksToolInput.Type;

/** Icon and color default to the agent defaults; the model defaults to the calling agent's. */
export const AgentCreateToolInput = Schema.Struct({
  name: FirstmateName,
  role: AgentRole.annotate({
    description: "One or two sentences that become the top of the new agent's AGENTS.md.",
  }),
  icon: Schema.optional(FirstmateIcon).annotate({
    description:
      "One of compass, ship-wheel, anchor, sparkles, bot, rocket, star, zap, brain, heart, flag, crown. Defaults to bot.",
  }),
  color: Schema.optional(ProjectIconColor),
  modelSelection: Schema.optional(ModelSelection).annotate({
    description:
      "The new agent's model, as orchestrator_capabilities lists it. Omit to use the calling agent's model.",
  }),
});
export type AgentCreateToolInput = typeof AgentCreateToolInput.Type;

export const AGENT_DEFAULT_ICON = "bot";

export const AgentArchiveInput = Schema.Struct({
  agentId: AgentProfileId,
});
export type AgentArchiveInput = typeof AgentArchiveInput.Type;

/** Starts a new chat for an agent whose chat is gone, or that never had one. */
export const AgentStartInput = Schema.Struct({
  agentId: AgentProfileId,
  modelSelection: ModelSelection,
});
export type AgentStartInput = typeof AgentStartInput.Type;

export const AgentStartResult = Schema.Struct({
  agent: AgentProfile,
  threadId: ThreadId,
});
export type AgentStartResult = typeof AgentStartResult.Type;

export class FirstmateError extends Schema.TaggedError<FirstmateError>()("FirstmateError", {
  message: Schema.String,
  taskId: Schema.optional(FirstmateTaskId),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Separate from upstream WS_METHODS so rpc.ts needs only an import and registration. */
export const FIRSTMATE_WS_METHODS = {
  firstmateSubscribe: "firstmate.subscribe",
  firstmateGetTask: "firstmate.getTask",
  firstmateSetCoordinator: "firstmate.setCoordinator",
  firstmateStart: "firstmate.start",
  firstmateSetAppearance: "firstmate.setAppearance",
  agentsSubscribe: "agents.subscribe",
  agentTasksSubscribe: "agents.tasks.subscribe",
  agentCreate: "agents.create",
  agentUpdate: "agents.update",
  agentArchive: "agents.archive",
  agentStart: "agents.start",
} as const;

/** Spread into the server's authorization table without duplicating feature policy. */
export const FIRSTMATE_RPC_REQUIRED_SCOPES = {
  [FIRSTMATE_WS_METHODS.firstmateSubscribe]: AuthOrchestrationReadScope,
  [FIRSTMATE_WS_METHODS.firstmateGetTask]: AuthOrchestrationReadScope,
  [FIRSTMATE_WS_METHODS.firstmateSetCoordinator]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.firstmateStart]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.firstmateSetAppearance]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.agentsSubscribe]: AuthOrchestrationReadScope,
  [FIRSTMATE_WS_METHODS.agentTasksSubscribe]: AuthOrchestrationReadScope,
  [FIRSTMATE_WS_METHODS.agentCreate]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.agentUpdate]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.agentArchive]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.agentStart]: AuthOrchestrationOperateScope,
} as const;

/** Incremental client guards for mutations; the server authorizes every RPC independently. */
export const FIRSTMATE_CLIENT_GUARDED_RPC_SCOPES = {
  [FIRSTMATE_WS_METHODS.firstmateSetCoordinator]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.firstmateStart]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.firstmateSetAppearance]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.agentCreate]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.agentUpdate]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.agentArchive]: AuthOrchestrationOperateScope,
  [FIRSTMATE_WS_METHODS.agentStart]: AuthOrchestrationOperateScope,
} as const;

const FirstmateRpcError = Schema.Union([FirstmateError, EnvironmentAuthorizationError]);

/** A full snapshot on subscribe, followed by another after each task or config change. */
export const FirstmateRpcs = [
  Rpc.make(FIRSTMATE_WS_METHODS.firstmateSubscribe, {
    payload: FirstmateSubscribeInput,
    success: FirstmateSnapshot,
    error: FirstmateRpcError,
    stream: true,
  }),
  Rpc.make(FIRSTMATE_WS_METHODS.firstmateGetTask, {
    payload: FirstmateGetTaskInput,
    success: FirstmateTaskDetail,
    error: FirstmateRpcError,
  }),
  Rpc.make(FIRSTMATE_WS_METHODS.firstmateSetCoordinator, {
    payload: FirstmateSetCoordinatorInput,
    success: FirstmateSetCoordinatorResult,
    error: FirstmateRpcError,
  }),
  Rpc.make(FIRSTMATE_WS_METHODS.firstmateStart, {
    payload: FirstmateStartInput,
    success: FirstmateStartResult,
    error: FirstmateRpcError,
  }),
  Rpc.make(FIRSTMATE_WS_METHODS.firstmateSetAppearance, {
    payload: FirstmateSetAppearanceInput,
    success: FirstmateSetAppearanceResult,
    error: FirstmateRpcError,
  }),
  Rpc.make(FIRSTMATE_WS_METHODS.agentsSubscribe, {
    payload: AgentsSubscribeInput,
    success: AgentsSnapshot,
    error: FirstmateRpcError,
    stream: true,
  }),
  Rpc.make(FIRSTMATE_WS_METHODS.agentTasksSubscribe, {
    payload: AgentTasksSubscribeInput,
    success: FirstmateSnapshot,
    error: FirstmateRpcError,
    stream: true,
  }),
  Rpc.make(FIRSTMATE_WS_METHODS.agentCreate, {
    payload: AgentCreateInput,
    success: AgentCreateResult,
    error: FirstmateRpcError,
  }),
  Rpc.make(FIRSTMATE_WS_METHODS.agentUpdate, {
    payload: AgentUpdateInput,
    success: AgentProfile,
    error: FirstmateRpcError,
  }),
  Rpc.make(FIRSTMATE_WS_METHODS.agentArchive, {
    payload: AgentArchiveInput,
    success: AgentProfile,
    error: FirstmateRpcError,
  }),
  Rpc.make(FIRSTMATE_WS_METHODS.agentStart, {
    payload: AgentStartInput,
    success: AgentStartResult,
    error: FirstmateRpcError,
  }),
] as const;
