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
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";
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
 *
 * A `monitoring` task is live in production with post-release checks still
 * open. Its legacy state is `open`: the work is active, not waiting on a merge.
 *
 * A `hillclimb` task is a worker climbing a frozen metric through rounds of
 * keep-or-revert experiments. Coordinators set it explicitly; it is never
 * inferred from a title. Its legacy state is `open`.
 */
export const FirstmateTaskState = Schema.Literals(["open", "waiting", "ready", "done", "dropped"]);
export type FirstmateTaskState = typeof FirstmateTaskState.Type;

/** The explicit lifecycle status shown by the Tasks panel. */
export const FirstmateTaskStatus = Schema.Literals([
  "backlog",
  "planning",
  "in_progress",
  "in_review",
  "ready_for_deployment",
  "monitoring",
  "hillclimb",
  "done",
  "canceled",
]);
export type FirstmateTaskStatus = typeof FirstmateTaskStatus.Type;

export const FirstmateNextActor = Schema.Literals(["coordinator", "worker", "user", "external"]);
export type FirstmateNextActor = typeof FirstmateNextActor.Type;

/** Compatibility at the boundary only; actor changes must not change a saved status. */
export function firstmateTaskStatus(task: {
  readonly status?: FirstmateTaskStatus | undefined;
  readonly state: FirstmateTaskState;
  readonly nextActor: FirstmateNextActor;
}): FirstmateTaskStatus {
  if (task.status !== undefined) return task.status;
  if (task.state === "done") return "done";
  if (task.state === "dropped") return "canceled";
  if (task.state === "ready") return "ready_for_deployment";
  if (task.state === "waiting") return "in_review";
  if (task.nextActor === "coordinator") return "planning";
  if (task.nextActor === "external") return "in_review";
  return "in_progress";
}

/** Legacy operational state is maintained by the service, not independently authored. */
export function firstmateStateForStatus(status: FirstmateTaskStatus): FirstmateTaskState {
  switch (status) {
    case "done":
      return "done";
    case "canceled":
      return "dropped";
    case "in_review":
      return "waiting";
    case "ready_for_deployment":
      return "ready";
    default:
      return "open";
  }
}

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

/**
 * A worker's latest measured progress on a task, written by the worker with
 * `task_report_progress` or by the coordinator with `firstmate_task_update`.
 * A `metric` is a score ("Recall 87.5%"); a `count` is done-out-of-total, with
 * the total in `target` ("1,611 / 1,942 hotels").
 */
const progressReportFields = {
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(40)).annotate({
    description: 'What is measured, e.g. "Recall" or "Hotels scraped".',
  }),
  kind: Schema.Literals(["metric", "count"]).annotate({
    description: "metric for a score; count for done out of a total, with the total in target.",
  }),
  value: Schema.Finite,
  baseline: Schema.optional(Schema.Finite).annotate({
    description: "The starting score, for a metric.",
  }),
  target: Schema.optional(Schema.Finite).annotate({
    description: "The score that reaches the goal, or the total for a count.",
  }),
  unit: Schema.optional(Schema.String.check(Schema.isMaxLength(16))).annotate({
    description: 'Shown after the number: "%", "ms", "hotels", "$". A "$" goes before it.',
  }),
  direction: Schema.optional(Schema.Literals(["higher", "lower"])).annotate({
    description: "Whether higher or lower is better. Omit for higher.",
  }),
};

/** A struct that fails on keys it does not declare, so a caller never mistakes a dropped field for an applied one. */
function closedStruct<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
): Schema.decodeTo<Schema.Struct<Fields>, Schema.Struct<Fields>> {
  const struct = Schema.Struct(fields);
  // The rest record only rejects keys; typed as the plain struct, callers never see its `never` index.
  const closed = Schema.StructWithRest(struct, [
    Schema.Record(
      Schema.String.check(
        Schema.makeFilter((key: string) => !Object.hasOwn(fields, key), {
          expected: `only the fields ${Object.keys(fields).join(", ")}`,
        }),
      ),
      Schema.Never,
    ),
  ]) as unknown as Schema.Struct<Fields>;
  return closed.pipe(Schema.decodeTo(struct));
}

export const FirstmateTaskProgressReport = closedStruct(progressReportFields);
export type FirstmateTaskProgressReport = typeof FirstmateTaskProgressReport.Type;

export const FirstmateTaskProgressPoint = Schema.Struct({
  value: Schema.Finite,
  at: IsoDateTime,
});
export type FirstmateTaskProgressPoint = typeof FirstmateTaskProgressPoint.Type;

/** At most this many past values are kept for the board's sparkline. */
export const FIRSTMATE_PROGRESS_HISTORY_LIMIT = 32;

/** The stored progress: the latest report, when it arrived, and its recent values, oldest first. */
export const FirstmateTaskProgress = Schema.Struct({
  ...progressReportFields,
  updatedAt: IsoDateTime,
  history: Schema.Array(FirstmateTaskProgressPoint),
});
export type FirstmateTaskProgress = typeof FirstmateTaskProgress.Type;

/** Public task model; reactor bookkeeping stays on the server. */
export const FirstmateTask = Schema.Struct({
  id: FirstmateTaskId,
  /** Older servers omit it; unmarked tasks are not priority. */
  priority: Schema.optional(Schema.Boolean),
  title: TrimmedNonEmptyString,
  intent: FirstmateIntent,
  definitionOfDone: TrimmedNonEmptyString,
  state: FirstmateTaskState,
  /** Optional for wire compatibility with servers predating explicit status. */
  status: Schema.optional(FirstmateTaskStatus),
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
  /** Older servers omit it; read it as none. */
  progress: Schema.optional(Schema.NullOr(FirstmateTaskProgress)),
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
  /** A signed asset can render an image avatar; older agents omit this field. */
  avatarAttachmentId: Schema.optional(TrimmedNonEmptyString),
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
  status: Schema.optional(FirstmateTaskStatus).annotate({
    description: "Filter by lifecycle status, including backlog or closed statuses.",
  }),
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
  priority: Schema.optional(Schema.Boolean),
  title: TrimmedNonEmptyString,
  intent: FirstmateIntent.annotate({ description: "The user's request in their own words." }),
  definitionOfDone: TrimmedNonEmptyString,
  status: Schema.optional(
    Schema.Literals([
      "backlog",
      "planning",
      "in_progress",
      "in_review",
      "ready_for_deployment",
      "monitoring",
      "hillclimb",
    ]),
  ).annotate({
    description:
      "Lifecycle status. Backlog is parked; do not start workers for it. Monitoring means live in production with post-release checks open. Hillclimb means a worker is climbing a measured goal.",
  }),
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
  priority: Schema.optional(Schema.Boolean),
  taskId: FirstmateTaskId,
  summary: TrimmedNonEmptyString.annotate({
    description: "Required summary for the append-only update event.",
  }),
  title: Schema.optional(TrimmedNonEmptyString),
  intent: Schema.optional(FirstmateIntent),
  definitionOfDone: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(FirstmateTaskStatus),
  state: Schema.optional(FirstmateTaskState).annotate({
    description: "Legacy compatibility input. Prefer status; the server maintains state from it.",
  }),
  nextActor: Schema.optional(FirstmateNextActor),
  nextStep: Schema.optional(Schema.NullOr(FirstmateNextStep)).annotate({
    description: `${NEXT_STEP_DESCRIPTION} Write it whenever status or nextActor changes. Null clears it.`,
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
  progress: Schema.optional(Schema.NullOr(FirstmateTaskProgressReport)).annotate({
    description:
      "Sets the task's progress line, as task_report_progress does. Null clears it and its history.",
  }),
}).check(
  Schema.makeFilter(
    (input) =>
      (input.state !== "done" &&
        input.state !== "dropped" &&
        input.status !== "done" &&
        input.status !== "canceled") ||
      input.closeEvidence != null,
    { expected: "closeEvidence when moving a task to done or dropped" },
  ),
);
export type FirstmateTaskUpdateInput = typeof FirstmateTaskUpdateInput.Type;

/** A worker's progress report on the task it works on; it changes nothing else. */
// A worker may change only progress: any other task field is an error, not ignored.
export const FirstmateTaskReportProgressInput = closedStruct({
  taskId: Schema.optional(FirstmateTaskId).annotate({
    description: "The task you work on. Omit when you are the worker of exactly one open task.",
  }),
  progress: FirstmateTaskProgressReport,
});
export type FirstmateTaskReportProgressInput = typeof FirstmateTaskReportProgressInput.Type;

export const FirstmateSetTaskPriorityInput = Schema.Struct({
  taskId: FirstmateTaskId,
  priority: Schema.Boolean,
});
export type FirstmateSetTaskPriorityInput = typeof FirstmateSetTaskPriorityInput.Type;

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
  avatarAttachmentId: Schema.optional(TrimmedNonEmptyString),
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
  avatarAttachmentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  role: Schema.optional(AgentRole),
});
export type AgentUpdateInput = typeof AgentUpdateInput.Type;

// --- agent MCP tools -------------------------------------------------------

export const AgentListToolInput = Schema.Struct({
  nameContains: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  cursor: Schema.optional(NonNegativeInt).annotate({
    description: "Live offset from nextCursor; omit for the first page.",
  }),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))).annotate({
    description: "Page size, 1 to 100. Defaults to 50.",
  }),
});
export type AgentListToolInput = typeof AgentListToolInput.Type;

export const AgentListToolResult = Schema.Struct({
  agents: ForwardCompatibleArray(AgentProfile),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type AgentListToolResult = typeof AgentListToolResult.Type;

export const AgentTasksToolInput = Schema.Struct({
  agentId: AgentProfileId,
  status: Schema.optional(FirstmateTaskStatus),
  state: Schema.optional(FirstmateTaskState).annotate({
    description: "Filter by state. Omit to list every task that is not done or dropped.",
  }),
  priority: Schema.optional(Schema.Boolean),
  nextActor: Schema.optional(FirstmateNextActor),
  cursor: Schema.optional(NonNegativeInt).annotate({
    description: "Live offset from nextCursor; omit for the first page.",
  }),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))).annotate({
    description: "Page size, 1 to 100. Defaults to 50.",
  }),
});
export type AgentTasksToolInput = typeof AgentTasksToolInput.Type;

export const AgentTasksToolResult = Schema.Struct({
  agentId: AgentProfileId,
  tasks: ForwardCompatibleArray(FirstmateTask),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type AgentTasksToolResult = typeof AgentTasksToolResult.Type;

export const AgentTaskGetToolInput = Schema.Struct({
  agentId: AgentProfileId,
  taskId: FirstmateTaskId,
});
export type AgentTaskGetToolInput = typeof AgentTaskGetToolInput.Type;

/** Public schedule details for one agent; webhook secrets and URLs are never exposed. */
export const AgentAutomation = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
  runCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentAutomation = typeof AgentAutomation.Type;

export const AgentAutomationsToolInput = Schema.Struct({
  agentId: AgentProfileId,
  enabled: Schema.optional(Schema.Boolean),
  scheduleType: Schema.optional(Schema.Literals(["interval", "fixed_time", "webhook"])),
  cursor: Schema.optional(NonNegativeInt).annotate({
    description: "Live offset from nextCursor; omit for the first page.",
  }),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))).annotate({
    description: "Page size, 1 to 100. Defaults to 50.",
  }),
});
export type AgentAutomationsToolInput = typeof AgentAutomationsToolInput.Type;

export const AgentAutomationsToolResult = Schema.Struct({
  agentId: AgentProfileId,
  automations: Schema.Array(AgentAutomation),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type AgentAutomationsToolResult = typeof AgentAutomationsToolResult.Type;

export const AgentAutomationGetToolInput = Schema.Struct({
  agentId: AgentProfileId,
  scheduledTaskId: ScheduledTaskId,
});
export type AgentAutomationGetToolInput = typeof AgentAutomationGetToolInput.Type;

export const AgentAutomationUpdateToolInput = Schema.Struct({
  agentId: AgentProfileId,
  scheduledTaskId: ScheduledTaskId,
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  prompt: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(120_000))),
  schedule: Schema.optional(ScheduledTaskUpsertSchedule),
  enabled: Schema.optional(Schema.Boolean),
});
export type AgentAutomationUpdateToolInput = typeof AgentAutomationUpdateToolInput.Type;

export const AgentAutomationMutationResult = Schema.Struct({
  agentId: AgentProfileId,
  automation: AgentAutomation,
});
export type AgentAutomationMutationResult = typeof AgentAutomationMutationResult.Type;

export const AgentAutomationDeleteToolInput = AgentAutomationGetToolInput;
export type AgentAutomationDeleteToolInput = typeof AgentAutomationDeleteToolInput.Type;

export const AgentAutomationDeleteToolResult = Schema.Struct({
  agentId: AgentProfileId,
  scheduledTaskId: ScheduledTaskId,
  deleted: Schema.Boolean,
});
export type AgentAutomationDeleteToolResult = typeof AgentAutomationDeleteToolResult.Type;

/** Icon and color default to the agent defaults; the model defaults to the calling agent's. */
export const AgentCreateToolInput = Schema.Struct({
  name: FirstmateName,
  role: AgentRole.annotate({
    description: "One or two sentences that become the top of the new agent's AGENTS.md.",
  }),
  icon: Schema.optional(FirstmateIcon).annotate({
    description:
      "Icon key such as bot, dollar-sign, wallet, chart-no-axes-combined, code, search, or compass. Defaults to bot.",
  }),
  color: Schema.optional(ProjectIconColor),
  avatarAttachmentId: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Pending image attachment ID from an upload. Omit to use icon and color.",
  }),
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
  firstmateSetTaskPriority: "firstmate.setTaskPriority",
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
  [FIRSTMATE_WS_METHODS.firstmateSetTaskPriority]: AuthOrchestrationOperateScope,
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
  [FIRSTMATE_WS_METHODS.firstmateSetTaskPriority]: AuthOrchestrationOperateScope,
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
  Rpc.make(FIRSTMATE_WS_METHODS.firstmateSetTaskPriority, {
    payload: FirstmateSetTaskPriorityInput,
    success: FirstmateTaskMutationResult,
    error: FirstmateRpcError,
  }),
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
