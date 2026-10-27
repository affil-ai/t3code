/**
 * The agent core: agents, their task boards, and their coordinator chats.
 * Every task operation is scoped to one agent. Firstmate is the reserved
 * agent `firstmate`, so its RPCs call in with that id and behave as before;
 * Agents mode creates the rest.
 *
 * @module FirstmateService
 */
import {
  AgentArchiveInput as ArchiveInput,
  AgentCreateInput as CreateAgentInput,
  type AgentProfile,
  AgentProfileId,
  type AgentsSnapshot,
  AgentStartInput as StartAgentInput,
  AgentUpdateInput as UpdateAgentInput,
  CommandId,
  FIRSTMATE_AGENT_ID,
  FIRSTMATE_DEFAULT_ICON,
  FIRSTMATE_DEFAULT_NAME,
  FirstmateError as ContractFirstmateError,
  FirstmateSnapshot as ContractFirstmateSnapshot,
  FirstmateTask as ContractFirstmateTask,
  FirstmateTaskEvent as ContractFirstmateTaskEvent,
  FirstmateTaskEventId,
  FirstmateTaskId,
  FirstmateTaskCreateInput as TaskCreateInput,
  FirstmateTaskUpdateInput as TaskUpdateInput,
  FirstmateTaskListInput as TaskListInput,
  FirstmateTaskReportProgressInput as ReportProgressInput,
  type FirstmateTaskArtifact,
  firstmateTaskStatus,
  firstmateStateForStatus,
  FirstmateSetAppearanceInput as AppearanceInput,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type StandupAddInput,
  type StandupArchiveInput,
  type StandupItemResult,
  type StandupListInput,
  type StandupListResult,
  type StandupSnapshot,
  type StandupSummary,
  type StandupUpdateInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { coordinatorKickoff } from "./coordinatorPrompt.ts";
import * as FirstmateHome from "./FirstmateHome.ts";
import { applyProgressReport } from "./progress.ts";
import * as Standup from "./standup.ts";
import * as Store from "./store.ts";
import {
  type AgentRow,
  agentFromRow,
  encodeArtifacts,
  encodeLinks,
  encodeModelSelection,
  encodeProgress,
  type EventRow,
  publicTask,
  type StoredTask,
  taskFromRow,
  type TaskRow,
} from "./store.ts";

export type FirstmateTask = typeof ContractFirstmateTask.Type;
export type FirstmateTaskEvent = typeof ContractFirstmateTaskEvent.Type;
export type FirstmateSnapshot = typeof ContractFirstmateSnapshot.Type;

export type FirstmateTaskListInput = typeof TaskListInput.Type;
export type FirstmateTaskCreateInput = typeof TaskCreateInput.Type;
export type FirstmateTaskUpdateInput = typeof TaskUpdateInput.Type;
export type FirstmateTaskReportProgressInput = typeof ReportProgressInput.Type;

export interface FirstmateTaskGetInput {
  readonly taskId: FirstmateTask["id"];
}
export interface FirstmateSetCoordinatorInput {
  readonly threadId: ThreadId | null;
}
export interface FirstmateSetAppearanceInput {
  readonly name: string;
  readonly icon: string;
}
export interface FirstmateStartInput {
  readonly modelSelection: ModelSelection;
}

export interface FirstmateTaskMutationResult {
  readonly task: FirstmateTask;
}
export interface FirstmateTaskDetail {
  readonly task: FirstmateTask;
  readonly events: ReadonlyArray<FirstmateTaskEvent>;
}
export interface FirstmateStartResult {
  readonly threadId: ThreadId;
  readonly snapshot: FirstmateSnapshot;
}
export type AgentCreateInput = typeof CreateAgentInput.Type;
export type AgentUpdateInput = typeof UpdateAgentInput.Type;
export type AgentArchiveInput = typeof ArchiveInput.Type;
export type AgentStartInput = typeof StartAgentInput.Type;
export interface AgentStartResult {
  readonly agent: AgentProfile;
  readonly threadId: ThreadId;
}

/** An agent with the coordinator chat the reactor should wake. */
export interface AgentCoordinator {
  readonly agentId: AgentProfileId;
  readonly threadId: ThreadId;
}

export type { StoredTask } from "./store.ts";

const isoNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);
const asTaskId = (value: string) => FirstmateTaskId.make(value);

function error(message: string, taskId?: FirstmateTask["id"], cause?: unknown) {
  return new ContractFirstmateError({
    message,
    ...(taskId === undefined ? {} : { taskId }),
    ...(cause === undefined ? {} : { cause }),
  });
}

const isFirstmateError = Schema.is(ContractFirstmateError);
// Service callers are typed, but MCP and tests can bypass trimming; decode re-checks it.
const decodeCreateInput = Schema.decodeUnknownEffect(TaskCreateInput);
const decodeUpdateInput = Schema.decodeUnknownEffect(TaskUpdateInput);
const decodeReportProgressInput = Schema.decodeUnknownEffect(ReportProgressInput);
/** How many delegated-subagent hops a progress report may climb to find its worker. */
const MAX_SUBAGENT_DEPTH = 8;
const decodeAppearanceInput = Schema.decodeUnknownEffect(AppearanceInput);
const decodeCreateAgentInput = Schema.decodeUnknownEffect(CreateAgentInput);
const decodeUpdateAgentInput = Schema.decodeUnknownEffect(UpdateAgentInput);

/** A folder name from an agent's display name: `Growth Lead` becomes `growth-lead`. */
export function slugFor(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length === 0 ? "agent" : slug;
}

export class FirstmateService extends Context.Service<
  FirstmateService,
  {
    readonly list: (
      agentId: AgentProfileId,
      input?: FirstmateTaskListInput,
    ) => Effect.Effect<{ readonly tasks: ReadonlyArray<FirstmateTask> }, ContractFirstmateError>;
    /** The agent's board: a snapshot now and after every change to any agent. */
    readonly subscribe: (
      agentId: AgentProfileId,
    ) => Stream.Stream<FirstmateSnapshot, ContractFirstmateError>;
    readonly get: (
      agentId: AgentProfileId,
      input: FirstmateTaskGetInput,
    ) => Effect.Effect<FirstmateTaskDetail, ContractFirstmateError>;
    readonly create: (
      agentId: AgentProfileId,
      input: FirstmateTaskCreateInput,
    ) => Effect.Effect<FirstmateTaskMutationResult, ContractFirstmateError>;
    readonly update: (
      agentId: AgentProfileId,
      input: FirstmateTaskUpdateInput,
    ) => Effect.Effect<FirstmateTaskMutationResult, ContractFirstmateError>;
    /**
     * A worker's progress report. It changes only `progress`, and only on an
     * open task whose worker is the calling thread or, for a delegated
     * subagent, the nearest thread above it that works on a task.
     */
    readonly reportProgress: (
      callerThreadId: ThreadId,
      input: FirstmateTaskReportProgressInput,
    ) => Effect.Effect<FirstmateTaskMutationResult, ContractFirstmateError>;
    /** Human priority changes preserve lifecycle, worker ownership, and task order. */
    readonly setTaskPriority: (input: {
      readonly taskId: FirstmateTask["id"];
      readonly priority: boolean;
    }) => Effect.Effect<FirstmateTaskMutationResult, ContractFirstmateError>;
    readonly setCoordinator: (
      agentId: AgentProfileId,
      input: FirstmateSetCoordinatorInput,
    ) => Effect.Effect<FirstmateSnapshot, ContractFirstmateError>;
    /** Seeds the agent's folder and starts its coordinator chat there. */
    readonly start: (
      agentId: AgentProfileId,
      input: FirstmateStartInput,
    ) => Effect.Effect<FirstmateStartResult, ContractFirstmateError>;
    /** Renames the agent and its coordinator chat, and sets its icon. */
    readonly setAppearance: (
      agentId: AgentProfileId,
      input: FirstmateSetAppearanceInput,
    ) => Effect.Effect<FirstmateSnapshot, ContractFirstmateError>;
    /** Internal reactor hook. It updates only the dedupe markers, not task history. */
    readonly markReportedRun: (
      taskId: FirstmateTask["id"],
      runId: string,
    ) => Effect.Effect<void, ContractFirstmateError>;
    readonly markTerminalNoticeRun: (
      taskId: FirstmateTask["id"],
      runId: string,
    ) => Effect.Effect<void, ContractFirstmateError>;
    readonly markOrphanNotified: (
      taskId: FirstmateTask["id"],
      at: string,
    ) => Effect.Effect<void, ContractFirstmateError>;
    /** Every open task of every agent, with its owner, for the reactor's sweep. */
    readonly listStored: () => Effect.Effect<ReadonlyArray<StoredTask>, ContractFirstmateError>;
    readonly coordinatorThreadId: (
      agentId: AgentProfileId,
    ) => Effect.Effect<ThreadId | null, ContractFirstmateError>;
    /** Unarchived agents that have a coordinator chat, for the reactor. */
    readonly coordinators: () => Effect.Effect<
      ReadonlyArray<AgentCoordinator>,
      ContractFirstmateError
    >;
    /**
     * The agent a calling thread acts for: its own coordinator chat, or the
     * agent whose task it works on. Null for any other thread.
     */
    readonly agentForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<AgentProfile | null, ContractFirstmateError>;
    readonly listAgents: () => Effect.Effect<ReadonlyArray<AgentProfile>, ContractFirstmateError>;
    readonly subscribeAgents: () => Stream.Stream<AgentsSnapshot, ContractFirstmateError>;
    /** Records the agent, seeds its folder, and starts its chat. */
    readonly createAgent: (
      input: AgentCreateInput,
    ) => Effect.Effect<AgentStartResult, ContractFirstmateError>;
    readonly updateAgent: (
      input: AgentUpdateInput,
    ) => Effect.Effect<AgentProfile, ContractFirstmateError>;
    /** Hides the agent from Agents mode; its chat, folder, and tasks stay. */
    readonly archiveAgent: (
      input: AgentArchiveInput,
    ) => Effect.Effect<AgentProfile, ContractFirstmateError>;
    readonly startAgent: (
      input: AgentStartInput,
    ) => Effect.Effect<AgentStartResult, ContractFirstmateError>;
    /** Adds a standup item; a linked task may be on any agent's board. */
    readonly addStandupItem: (
      callerAgentId: AgentProfileId,
      input: StandupAddInput,
    ) => Effect.Effect<StandupItemResult, ContractFirstmateError>;
    readonly updateStandupItem: (
      callerAgentId: AgentProfileId,
      input: StandupUpdateInput,
    ) => Effect.Effect<StandupItemResult, ContractFirstmateError>;
    readonly archiveStandupItem: (
      input: StandupArchiveInput,
    ) => Effect.Effect<StandupItemResult, ContractFirstmateError>;
    readonly listStandup: (
      input: StandupListInput,
    ) => Effect.Effect<StandupListResult, ContractFirstmateError>;
    /** Open standup items now and after every change to any board. */
    readonly subscribeStandup: () => Stream.Stream<StandupSnapshot, ContractFirstmateError>;
    readonly standupSummary: () => Effect.Effect<StandupSummary, ContractFirstmateError>;
  }
>()("t3/firstmate/FirstmateService") {}

export const layer = Layer.effect(
  FirstmateService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const changes = yield* PubSub.sliding<void>(1);
    const home = yield* FirstmateHome.FirstmateHome;
    const launches = yield* ThreadLaunchService.ThreadLaunchService;
    const threads = yield* ThreadManagementService.ThreadManagementService;

    yield* Store.ensureSchema;
    // A `~/firstmate` from before agents moves into the shared repository once.
    // Kept review images move with it, so their stored paths follow.
    // Images kept under a moved folder now sit in the repository's artifacts/,
    // so their stored paths go there; any other path follows the folder.
    const repointArtifacts = (from: string, to: string) =>
      Effect.gen(function* () {
        const keptFrom = `${from}/artifacts/`;
        const keptTo = `${home.artifactsRoot}/`;
        yield* sql`
          UPDATE firstmate_task SET artifacts_json = replace(artifacts_json, ${keptFrom}, ${keptTo})
          WHERE artifacts_json LIKE ${`%${keptFrom}%`}
        `;
        yield* sql`
          UPDATE firstmate_task SET artifacts_json = replace(artifacts_json, ${`${from}/`}, ${`${to}/`})
          WHERE artifacts_json LIKE ${`%${from}/%`}
        `;
      });
    const moved = yield* home.migrateLegacyHome();
    if (moved !== null) yield* repointArtifacts(moved.from, moved.to);
    // Agents' folders move from `agents/` to `crew/` once. The first move left
    // kept images' paths under `agents/firstmate/artifacts/`; this repairs them.
    for (const folder of yield* home.migrateAgentsFolder()) {
      yield* repointArtifacts(folder.from, folder.to);
    }

    const now = () => Effect.map(isoNow, (at) => DateTime.formatIso(DateTime.toUtc(at)));
    // Standup items follow their tasks, so record finishes before anyone re-reads.
    // Items linked to tasks that finished before this build, or while it was down.
    yield* now().pipe(
      Effect.flatMap(Standup.syncStandupFinished),
      Effect.catchCause((cause) => Effect.logWarning("Could not sync the standup.", { cause })),
    );
    const notify = now().pipe(
      Effect.flatMap(Standup.syncStandupFinished),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchCause((cause) => Effect.logWarning("Could not sync the standup.", { cause })),
      Effect.andThen(PubSub.publish(changes, undefined)),
      Effect.asVoid,
    );
    const dbError = (message: string, taskId?: FirstmateTask["id"]) => (cause: unknown) =>
      isFirstmateError(cause) ? cause : error(message, taskId, cause);

    // --- agents -----------------------------------------------------------

    const readAgentRow = (agentId: AgentProfileId) =>
      sql<AgentRow>`SELECT * FROM firstmate_agent WHERE agent_id = ${agentId}`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.mapError(dbError("Could not read the agent.")),
      );
    const requireAgent = (agentId: AgentProfileId) =>
      readAgentRow(agentId).pipe(
        Effect.flatMap((row) =>
          row === undefined
            ? error(`Agent ${agentId} was not found.`)
            : Effect.succeed(agentFromRow(row)),
        ),
      );
    const listAgents: FirstmateService["Service"]["listAgents"] = () =>
      sql<AgentRow>`SELECT * FROM firstmate_agent WHERE archived_at IS NULL ORDER BY rowid ASC`.pipe(
        Effect.map((rows) => rows.map(agentFromRow)),
        Effect.mapError(dbError("Could not list agents.")),
      );
    const coordinators: FirstmateService["Service"]["coordinators"] = () =>
      listAgents().pipe(
        Effect.map((agents) =>
          agents.flatMap((agent) =>
            agent.coordinatorThreadId === null
              ? []
              : [{ agentId: agent.id, threadId: agent.coordinatorThreadId }],
          ),
        ),
      );
    const coordinatorThreadId: FirstmateService["Service"]["coordinatorThreadId"] = (agentId) =>
      readAgentRow(agentId).pipe(
        Effect.map((row) =>
          row?.coordinator_thread_id == null ? null : ThreadId.make(row.coordinator_thread_id),
        ),
      );
    const agentForThread: FirstmateService["Service"]["agentForThread"] = (threadId) =>
      Effect.gen(function* () {
        const own = yield* sql<AgentRow>`
          SELECT * FROM firstmate_agent WHERE coordinator_thread_id = ${threadId} AND archived_at IS NULL
        `;
        if (own[0] !== undefined) return agentFromRow(own[0]);
        const working = yield* sql<AgentRow>`
          SELECT a.* FROM firstmate_agent a
          JOIN firstmate_task t ON t.agent_id = a.agent_id
          WHERE t.worker_thread_id = ${threadId}
          ORDER BY t.updated_at DESC LIMIT 1
        `;
        return working[0] === undefined ? null : agentFromRow(working[0]);
      }).pipe(Effect.mapError(dbError("Could not find the calling thread's agent.")));
    /** Firstmate's row mirrors into firstmate_config, so an older build can still read it. */
    const mirrorFirstmateConfig = (agentId: AgentProfileId) =>
      agentId !== FIRSTMATE_AGENT_ID
        ? Effect.void
        : sql`
            UPDATE firstmate_config SET
              coordinator_thread_id = (SELECT coordinator_thread_id FROM firstmate_agent WHERE agent_id = ${agentId}),
              home_project_id = (SELECT home_project_id FROM firstmate_agent WHERE agent_id = ${agentId}),
              name = (SELECT name FROM firstmate_agent WHERE agent_id = ${agentId}),
              icon = (SELECT icon FROM firstmate_agent WHERE agent_id = ${agentId})
            WHERE config_id = 1
          `.pipe(Effect.asVoid);

    // --- tasks ------------------------------------------------------------

    const assertCanPark = Effect.fn("Firstmate.assertCanPark")(function* (
      workerThreadId: ThreadId | null,
    ) {
      if (workerThreadId === null) return;
      const worker = yield* threads.getThreadShell(workerThreadId);
      if (
        worker !== null &&
        (worker.activeRunId !== null ||
          ["preparing", "queued", "starting", "running", "waiting"].includes(worker.status) ||
          (worker.pendingBackgroundTasks?.length ?? 0) > 0)
      ) {
        return yield* error(
          "The worker is still active. Stop or finish its work before moving this task to backlog.",
        );
      }
    });

    const selectRows = (agentId: AgentProfileId, input?: FirstmateTaskListInput) => {
      if (input?.status !== undefined) {
        if (input.state !== undefined)
          return sql<TaskRow>`SELECT * FROM firstmate_task WHERE agent_id = ${agentId} AND status = ${input.status} AND state = ${input.state} ORDER BY updated_at DESC, task_id DESC`;
        return sql<TaskRow>`SELECT * FROM firstmate_task WHERE agent_id = ${agentId} AND status = ${input.status} ORDER BY updated_at DESC, task_id DESC`;
      }
      if (input?.state !== undefined) {
        return sql<TaskRow>`SELECT * FROM firstmate_task WHERE agent_id = ${agentId} AND state = ${input.state} ORDER BY updated_at DESC, task_id DESC`;
      }
      return sql<TaskRow>`SELECT * FROM firstmate_task WHERE agent_id = ${agentId} AND state NOT IN ('done', 'dropped') ORDER BY updated_at DESC, task_id DESC`;
    };
    // Screenshots usually sit in a worker's worktree, which is recycled; keep a copy.
    const keepArtifacts = (
      taskId: FirstmateTask["id"],
      artifacts: ReadonlyArray<FirstmateTaskArtifact>,
    ) =>
      Effect.forEach(artifacts, (artifact) =>
        artifact.kind === "image"
          ? home.keepImage({ taskId, path: artifact.url }).pipe(
              Effect.map((url) => ({ ...artifact, url })),
              Effect.mapError((cause) =>
                error(`Could not save the review image ${artifact.url}.`, taskId, cause),
              ),
            )
          : Effect.succeed(artifact),
      );
    const listStored: FirstmateService["Service"]["listStored"] = () =>
      sql<TaskRow>`SELECT * FROM firstmate_task WHERE state NOT IN ('done', 'dropped') ORDER BY updated_at DESC, task_id DESC`.pipe(
        Effect.map((rows) => rows.map(taskFromRow)),
        Effect.mapError(dbError("Could not list tasks.")),
      );
    const readSnapshotTasks = (agentId: AgentProfileId) =>
      Effect.all({
        open: sql<TaskRow>`
          SELECT * FROM firstmate_task
          WHERE agent_id = ${agentId} AND state NOT IN ('done', 'dropped')
          ORDER BY updated_at DESC, task_id DESC
        `,
        closed: sql<TaskRow>`
          SELECT * FROM firstmate_task
          WHERE agent_id = ${agentId} AND state IN ('done', 'dropped')
          ORDER BY closed_at DESC, updated_at DESC, task_id DESC
          LIMIT 20
        `,
      }).pipe(
        Effect.map(({ open, closed }) => [...open, ...closed].map(taskFromRow)),
        Effect.mapError(dbError("Could not read the tasks for the board.")),
      );
    const snapshot = (agentId: AgentProfileId) =>
      Effect.all({ agent: readAgentRow(agentId), rows: readSnapshotTasks(agentId) }).pipe(
        Effect.map(
          ({ agent, rows }) =>
            ({
              agentId,
              coordinatorThreadId:
                agent?.coordinator_thread_id == null
                  ? null
                  : ThreadId.make(agent.coordinator_thread_id),
              homeProjectId:
                agent?.home_project_id == null ? null : ProjectId.make(agent.home_project_id),
              name: agent?.name ?? FIRSTMATE_DEFAULT_NAME,
              icon: agent?.icon ?? FIRSTMATE_DEFAULT_ICON,
              tasks: rows.map(publicTask),
            }) as FirstmateSnapshot,
        ),
        Effect.mapError(dbError("Could not read the board.")),
      );

    const eventFor = (row: EventRow): FirstmateTaskEvent => ({
      id: FirstmateTaskEventId.make(row.event_id),
      taskId: asTaskId(row.task_id),
      createdAt: row.created_at,
      actor: row.actor as FirstmateTaskEvent["actor"],
      summary: row.summary,
    });
    const eventsFor = (taskId: FirstmateTask["id"]) =>
      sql<EventRow>`SELECT * FROM firstmate_task_event WHERE task_id = ${taskId} ORDER BY created_at ASC, rowid ASC`.pipe(
        Effect.map((rows) => rows.map(eventFor)),
        Effect.mapError(dbError("Could not read the task's events.", taskId)),
      );
    /** The event that records a change to a task's next step. */
    const nextStepEvent = (nextStep: string | null) =>
      nextStep === null ? "Next step cleared." : `Next step: ${nextStep}`;
    const appendEvent = (
      taskId: FirstmateTask["id"],
      summary: string,
      actor: FirstmateTaskEvent["actor"],
      at: string,
    ) =>
      Effect.gen(function* () {
        const eventId = `firstmate-event:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`;
        yield* sql`
          INSERT INTO firstmate_task_event(event_id, task_id, created_at, actor, summary)
          VALUES (${eventId}, ${taskId}, ${at}, ${actor}, ${summary})
        `.pipe(Effect.mapError(dbError("Could not record the task event.", taskId)));
      });
    /** The task when it exists and belongs to `agentId`; another agent's task is "not found". */
    const readOwnTask = (agentId: AgentProfileId, taskId: FirstmateTask["id"]) =>
      sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = ${taskId} AND agent_id = ${agentId}`.pipe(
        Effect.map((rows) => (rows[0] === undefined ? undefined : taskFromRow(rows[0]))),
      );

    const list: FirstmateService["Service"]["list"] = (agentId, input) =>
      selectRows(agentId, input).pipe(
        Effect.map((rows) => ({ tasks: rows.map(taskFromRow).map(publicTask) })),
        Effect.mapError(dbError("Could not list tasks.")),
      );
    const subscribe: FirstmateService["Service"]["subscribe"] = (agentId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(snapshot(agentId)),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot(agentId))),
          );
        }),
      );
    const subscribeAgents: FirstmateService["Service"]["subscribeAgents"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const agentsSnapshot = () =>
            listAgents().pipe(Effect.map((agents): AgentsSnapshot => ({ agents })));
          return Stream.concat(
            Stream.fromEffect(agentsSnapshot()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(agentsSnapshot)),
          );
        }),
      );
    const get: FirstmateService["Service"]["get"] = (agentId, input) =>
      Effect.gen(function* () {
        const task = yield* readOwnTask(agentId, input.taskId);
        if (task === undefined) return yield* error("Task was not found.", input.taskId);
        return { task: publicTask(task), events: yield* eventsFor(input.taskId) };
      }).pipe(Effect.mapError(dbError("Could not get the task.", input.taskId)));
    const create: FirstmateService["Service"]["create"] = (agentId, raw) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const input = yield* decodeCreateInput(raw);
            const status =
              input.status ??
              firstmateTaskStatus({
                state: "open",
                nextActor: input.nextActor ?? "coordinator",
              });
            if (status === "backlog") yield* assertCanPark(input.workerThreadId ?? null);
            const at = yield* now();
            const taskId = asTaskId(
              `firstmate-task:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
            );
            const task: StoredTask = {
              id: taskId,
              priority: input.priority ?? false,
              agentId,
              title: input.title,
              intent: input.intent,
              definitionOfDone: input.definitionOfDone,
              state: firstmateStateForStatus(status),
              status,
              nextActor: input.nextActor ?? "coordinator",
              nextStep: input.nextStep ?? null,
              note: input.note ?? "",
              wakeAt: status === "backlog" ? null : (input.wakeAt ?? null),
              workerThreadId: input.workerThreadId ?? null,
              links: input.links ?? [],
              artifacts: yield* keepArtifacts(taskId, input.artifacts ?? []),
              closeEvidence: null,
              progress: null,
              createdAt: at,
              updatedAt: at,
              closedAt: null,
              lastReportedRunId: null,
              lastTerminalNoticeRunId: null,
              orphanNotifiedAt: null,
            };
            yield* sql`
          INSERT INTO firstmate_task ${sql.insert({
            task_id: task.id,
            priority: task.priority ? 1 : 0,
            agent_id: task.agentId,
            title: task.title,
            intent: task.intent,
            definition_of_done: task.definitionOfDone,
            state: task.state,
            status: task.status ?? null,
            next_actor: task.nextActor,
            next_step: task.nextStep ?? null,
            note: task.note,
            wake_at: task.wakeAt,
            worker_thread_id: task.workerThreadId,
            links_json: encodeLinks(task.links),
            artifacts_json: encodeArtifacts(task.artifacts ?? []),
            close_evidence: task.closeEvidence,
            progress_json: null,
            created_at: task.createdAt,
            updated_at: task.updatedAt,
            closed_at: task.closedAt,
            last_reported_run_id: task.lastReportedRunId,
            last_terminal_notice_run_id: task.lastTerminalNoticeRunId,
            orphan_notified_at: task.orphanNotifiedAt,
          })}
        `.pipe(Effect.mapError(dbError("Could not create the task.", task.id)));
            yield* appendEvent(task.id, input.summary ?? "Task created.", "coordinator", at);
            if (task.nextStep)
              yield* appendEvent(task.id, nextStepEvent(task.nextStep), "coordinator", at);
            return { task: publicTask(task) };
          }),
        )
        .pipe(
          Effect.mapError(dbError("Could not create the task.")),
          Effect.tap(() => notify),
        );
    const update: FirstmateService["Service"]["update"] = (agentId, raw) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const input = yield* decodeUpdateInput(raw);
            const existing = yield* readOwnTask(agentId, input.taskId);
            if (existing === undefined) return yield* error("Task was not found.", input.taskId);
            // Old callers can still move the lifecycle with state. Changing
            // the next actor alone never changes the stored status.
            const status =
              input.status ??
              (input.state !== undefined && input.state !== existing.state
                ? firstmateTaskStatus({
                    state: input.state,
                    nextActor: input.nextActor ?? existing.nextActor,
                  })
                : firstmateTaskStatus(existing));
            const nextState = firstmateStateForStatus(status);
            if (status === "backlog")
              yield* assertCanPark(
                input.workerThreadId === undefined ? existing.workerThreadId : input.workerThreadId,
              );
            if (
              input.status !== undefined &&
              input.state !== undefined &&
              input.state !== nextState
            )
              return yield* error("Status and state disagree. Send status only.", input.taskId);
            const closing = nextState === "done" || nextState === "dropped";
            const evidence =
              input.closeEvidence === undefined ? existing.closeEvidence : input.closeEvidence;
            if (closing && (evidence === null || evidence.trim() === ""))
              return yield* error("Closing a task requires closeEvidence.", input.taskId);
            const at = yield* now();
            const next: StoredTask = {
              ...existing,
              ...(input.priority === undefined ? {} : { priority: input.priority }),
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.intent === undefined ? {} : { intent: input.intent }),
              ...(input.definitionOfDone === undefined
                ? {}
                : { definitionOfDone: input.definitionOfDone }),
              state: nextState,
              status,
              ...(input.nextActor === undefined ? {} : { nextActor: input.nextActor }),
              ...(input.nextStep === undefined ? {} : { nextStep: input.nextStep }),
              ...(input.note === undefined ? {} : { note: input.note }),
              ...(status === "backlog"
                ? { wakeAt: null }
                : input.wakeAt === undefined
                  ? {}
                  : { wakeAt: input.wakeAt }),
              ...(input.workerThreadId === undefined
                ? {}
                : { workerThreadId: input.workerThreadId }),
              ...(input.links === undefined ? {} : { links: input.links }),
              artifacts: [
                ...(input.artifacts === undefined
                  ? (existing.artifacts ?? [])
                  : yield* keepArtifacts(existing.id, input.artifacts)),
                ...(yield* keepArtifacts(existing.id, input.addArtifacts ?? [])),
              ],
              closeEvidence: evidence,
              progress:
                input.progress === undefined
                  ? (existing.progress ?? null)
                  : input.progress === null
                    ? null
                    : applyProgressReport(existing.progress ?? null, input.progress, at),
              updatedAt: at,
              closedAt: closing ? (existing.closedAt ?? at) : null,
              orphanNotifiedAt: null,
            };
            yield* sql`
          UPDATE firstmate_task SET
            priority = ${next.priority ? 1 : 0},
            title = ${next.title}, intent = ${next.intent}, definition_of_done = ${next.definitionOfDone},
            state = ${next.state}, status = ${next.status ?? null}, next_actor = ${next.nextActor}, next_step = ${next.nextStep ?? null}, note = ${next.note}, wake_at = ${next.wakeAt},
            worker_thread_id = ${next.workerThreadId}, links_json = ${encodeLinks(next.links)},
            artifacts_json = ${encodeArtifacts(next.artifacts ?? [])},
            close_evidence = ${next.closeEvidence}, progress_json = ${encodeProgress(next.progress ?? null)},
            updated_at = ${next.updatedAt}, closed_at = ${next.closedAt},
            orphan_notified_at = NULL
          WHERE task_id = ${next.id}
        `.pipe(Effect.mapError(dbError("Could not update the task.", next.id)));
            yield* appendEvent(next.id, input.summary, "coordinator", at);
            const nextStep = next.nextStep ?? null;
            if (nextStep !== (existing.nextStep ?? null))
              yield* appendEvent(next.id, nextStepEvent(nextStep), "coordinator", at);
            return { task: publicTask(next) };
          }),
        )
        .pipe(
          Effect.mapError(dbError("Could not update the task.", raw.taskId)),
          Effect.tap(() => notify),
        );
    const openTasksWorkedBy = (threadId: ThreadId) =>
      sql<TaskRow>`
        SELECT * FROM firstmate_task
        WHERE worker_thread_id = ${threadId} AND state NOT IN ('done', 'dropped')
      `.pipe(Effect.map((rows) => rows.map(taskFromRow)));
    /**
     * The thread a report speaks for: the caller, or the nearest thread above
     * it, through delegated-subagent links only, that works on `taskId` or,
     * without one, on any open task. Null when there is none.
     */
    const reportingWorker = (callerThreadId: ThreadId, taskId: FirstmateTask["id"] | undefined) =>
      Effect.gen(function* () {
        let threadId: ThreadId | null = callerThreadId;
        for (let hop = 0; threadId !== null && hop <= MAX_SUBAGENT_DEPTH; hop += 1) {
          const worked = yield* openTasksWorkedBy(threadId);
          if (taskId === undefined ? worked.length > 0 : worked.some((task) => task.id === taskId))
            return threadId;
          // Only a delegated subagent reports for its parent; a fork is its own conversation.
          const shell: OrchestrationV2ThreadShell | null = yield* threads.getThreadShell(threadId);
          threadId =
            shell?.lineage.relationshipToParent === "subagent"
              ? shell.lineage.parentThreadId
              : null;
        }
        return null;
      });
    const reportProgress: FirstmateService["Service"]["reportProgress"] = (callerThreadId, raw) =>
      Effect.gen(function* () {
        const input = yield* decodeReportProgressInput(raw);
        // Thread lookups stay outside the write transaction.
        const worker = yield* reportingWorker(callerThreadId, input.taskId);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const worked = worker === null ? [] : yield* openTasksWorkedBy(worker);
            const task =
              input.taskId === undefined
                ? worked.length === 1
                  ? worked[0]
                  : undefined
                : worked.find((candidate) => candidate.id === input.taskId);
            if (task === undefined) {
              return yield* error(
                input.taskId === undefined && worked.length > 1
                  ? "You work on more than one open task. Pass taskId."
                  : "You can report progress only on an open task you are the worker for.",
                input.taskId,
              );
            }
            const progress = applyProgressReport(
              task.progress ?? null,
              input.progress,
              yield* now(),
            );
            // Progress has its own updatedAt; leaving the task's keeps board order and wakes as they were.
            yield* sql`UPDATE firstmate_task SET progress_json = ${encodeProgress(progress)} WHERE task_id = ${task.id}`;
            return { task: publicTask({ ...task, progress }) };
          }),
        );
      }).pipe(
        Effect.mapError(dbError("Could not report the task's progress.", raw.taskId)),
        Effect.tap(() => notify),
      );
    const setCoordinator: FirstmateService["Service"]["setCoordinator"] = (agentId, input) =>
      sql`UPDATE firstmate_agent SET coordinator_thread_id = ${input.threadId} WHERE agent_id = ${agentId}`.pipe(
        Effect.andThen(mirrorFirstmateConfig(agentId)),
        Effect.mapError(dbError("Could not set the coordinator chat.")),
        Effect.andThen(notify),
        Effect.andThen(snapshot(agentId)),
      );

    // --- starting and shaping agents ---------------------------------------

    /** Seeds the agent's folder and starts its chat; returns the new coordinator. */
    const launchCoordinator = (agent: AgentProfile, modelSelection: ModelSelection) =>
      Effect.gen(function* () {
        // The coordinator runs at the agent's folder, so the provider loads the
        // shared AGENTS.md above it and its own, plus its notes and skills.
        const { projectId } = yield* home.ensure({
          slug: agent.slug,
          name: agent.name,
          role: agent.role,
        });
        yield* sql`
          UPDATE firstmate_agent SET home_project_id = ${projectId},
            model_selection_json = ${encodeModelSelection(modelSelection)}
          WHERE agent_id = ${agent.id}
        `.pipe(Effect.mapError(dbError("Could not record the agent's project.")));
        const launched = yield* launches.launch({
          commandId: CommandId.make(
            `firstmate:start:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          ),
          projectId,
          title: agent.name,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make(
              `firstmate:prompt:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
            ),
            text: coordinatorKickoff(agent.name),
            attachments: [],
          },
          createdBy: "user",
          creationSource: "web",
        });
        yield* setCoordinator(agent.id, { threadId: launched.threadId });
        return launched.threadId;
      });
    const start: FirstmateService["Service"]["start"] = (agentId, input) =>
      Effect.gen(function* () {
        const agent = yield* requireAgent(agentId);
        const threadId = yield* launchCoordinator(agent, input.modelSelection);
        return { threadId, snapshot: yield* snapshot(agentId) };
      }).pipe(Effect.mapError(dbError(`Could not start the agent.`)));
    const startAgent: FirstmateService["Service"]["startAgent"] = (input) =>
      Effect.gen(function* () {
        const agent = yield* requireAgent(input.agentId);
        const threadId = yield* launchCoordinator(agent, input.modelSelection);
        return { agent: yield* requireAgent(input.agentId), threadId };
      }).pipe(Effect.mapError(dbError("Could not start the agent.")));
    /** Renames the coordinator chat the way a thread rename does, when it still exists. */
    const renameCoordinator = (threadId: ThreadId, title: string) =>
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null || shell.title === title) return;
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(
            `firstmate:rename:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
          ),
          threadId,
          title,
        });
      }).pipe(Effect.mapError(dbError("Could not rename the agent's chat.")));
    const applyName = (agent: AgentProfile, name: string) =>
      Effect.gen(function* () {
        if (agent.coordinatorThreadId !== null)
          yield* renameCoordinator(agent.coordinatorThreadId, name);
        yield* home.rename({ slug: agent.slug, name });
      });
    const setAppearance: FirstmateService["Service"]["setAppearance"] = (agentId, raw) =>
      Effect.gen(function* () {
        const input = yield* decodeAppearanceInput(raw);
        const agent = yield* requireAgent(agentId);
        yield* sql`UPDATE firstmate_agent SET name = ${input.name}, icon = ${input.icon} WHERE agent_id = ${agentId}`;
        yield* mirrorFirstmateConfig(agentId);
        yield* notify;
        yield* applyName(agent, input.name);
        return yield* snapshot(agentId);
      }).pipe(Effect.mapError(dbError("Could not save the name and icon.")));
    const createAgent: FirstmateService["Service"]["createAgent"] = (raw) =>
      Effect.gen(function* () {
        const input = yield* decodeCreateAgentInput(raw);
        const taken = new Set(
          (yield* sql<{ slug: string }>`SELECT slug FROM firstmate_agent`).map((row) => row.slug),
        );
        const base = slugFor(input.name);
        let slug = base;
        for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
        const agentId = AgentProfileId.make(
          `agent:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
        );
        const at = yield* now();
        const avatarAttachmentId =
          input.avatarAttachmentId === undefined
            ? null
            : yield* home.keepAvatar({ agentId, attachmentId: input.avatarAttachmentId });
        yield* sql`
          INSERT INTO firstmate_agent ${sql.insert({
            agent_id: agentId,
            slug,
            name: input.name,
            icon: input.icon,
            color: input.color,
            avatar_attachment_id: avatarAttachmentId,
            role: input.role,
            coordinator_thread_id: null,
            home_project_id: null,
            model_selection_json: encodeModelSelection(input.modelSelection),
            created_at: at,
            archived_at: null,
          })}
        `;
        yield* notify;
        const threadId = yield* launchCoordinator(
          yield* requireAgent(agentId),
          input.modelSelection,
        );
        return { agent: yield* requireAgent(agentId), threadId };
      }).pipe(Effect.mapError(dbError("Could not create the agent.")));
    const updateAgent: FirstmateService["Service"]["updateAgent"] = (raw) =>
      Effect.gen(function* () {
        const input = yield* decodeUpdateAgentInput(raw);
        const agent = yield* requireAgent(input.agentId);
        const avatarAttachmentId =
          input.avatarAttachmentId === undefined
            ? (agent.avatarAttachmentId ?? null)
            : input.avatarAttachmentId === null ||
                input.avatarAttachmentId === agent.avatarAttachmentId
              ? input.avatarAttachmentId
              : yield* home.keepAvatar({
                  agentId: agent.id,
                  attachmentId: input.avatarAttachmentId,
                });
        yield* sql`
          UPDATE firstmate_agent SET
            name = ${input.name ?? agent.name}, icon = ${input.icon ?? agent.icon},
            color = ${input.color ?? agent.color},
            avatar_attachment_id = ${avatarAttachmentId},
            role = ${input.role ?? agent.role}
          WHERE agent_id = ${agent.id}
        `;
        yield* mirrorFirstmateConfig(agent.id);
        yield* notify;
        if (input.name !== undefined && input.name !== agent.name)
          yield* applyName(agent, input.name);
        if (input.role !== undefined && input.role !== agent.role)
          yield* home.writeRole({
            slug: agent.slug,
            name: input.name ?? agent.name,
            role: input.role,
          });
        return yield* requireAgent(agent.id);
      }).pipe(Effect.mapError(dbError("Could not update the agent.")));

    const archiveAgent: FirstmateService["Service"]["archiveAgent"] = (input) =>
      Effect.gen(function* () {
        if (input.agentId === FIRSTMATE_AGENT_ID)
          return yield* error("Firstmate cannot be archived.");
        yield* requireAgent(input.agentId);
        const at = yield* now();
        yield* sql`UPDATE firstmate_agent SET archived_at = ${at} WHERE agent_id = ${input.agentId}`;
        yield* notify;
        return yield* requireAgent(input.agentId);
      }).pipe(Effect.mapError(dbError("Could not archive the agent.")));

    const markReportedRun: FirstmateService["Service"]["markReportedRun"] = (taskId, runId) =>
      sql`UPDATE firstmate_task SET last_reported_run_id = ${runId}, updated_at = updated_at WHERE task_id = ${taskId}`.pipe(
        Effect.mapError(dbError("Could not record the wake.", taskId)),
        Effect.asVoid,
      );
    const markOrphanNotified: FirstmateService["Service"]["markOrphanNotified"] = (taskId, at) =>
      sql`UPDATE firstmate_task SET orphan_notified_at = ${at} WHERE task_id = ${taskId}`.pipe(
        Effect.mapError(dbError("Could not record the orphan wake.", taskId)),
        Effect.asVoid,
      );
    const markTerminalNoticeRun: FirstmateService["Service"]["markTerminalNoticeRun"] = (
      taskId,
      runId,
    ) =>
      sql`UPDATE firstmate_task SET last_terminal_notice_run_id = ${runId} WHERE task_id = ${taskId}`.pipe(
        Effect.mapError(dbError("Could not record the terminal notice wake.", taskId)),
        Effect.asVoid,
      );

    const setTaskPriority: FirstmateService["Service"]["setTaskPriority"] = (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows =
              yield* sql<Store.TaskRow>`SELECT * FROM firstmate_task WHERE task_id = ${input.taskId}`;
            const row = rows[0];
            if (row === undefined) return yield* error("Task was not found.", input.taskId);
            const task = Store.taskFromRow(row);
            if (task.priority === input.priority) return { task: publicTask(task) };
            yield* sql`UPDATE firstmate_task SET priority = ${input.priority ? 1 : 0} WHERE task_id = ${input.taskId}`;
            yield* appendEvent(
              input.taskId,
              input.priority ? "Marked as priority." : "Removed priority.",
              "user",
              yield* now(),
            );
            return { task: publicTask({ ...task, priority: input.priority }) };
          }),
        )
        .pipe(
          Effect.mapError(dbError("Could not change task priority.", input.taskId)),
          Effect.tap(() => notify),
        );

    const standup = yield* Standup.makeStandup({
      now,
      notify,
      threads,
      agentNames: () =>
        listAgents().pipe(
          Effect.map((agents) => new Map(agents.map((agent) => [agent.id, agent.name]))),
        ),
    });
    const subscribeStandup: FirstmateService["Service"]["subscribeStandup"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(standup.snapshot()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(standup.snapshot)),
          );
        }),
      );

    return {
      addStandupItem: standup.add,
      updateStandupItem: standup.update,
      archiveStandupItem: standup.archive,
      listStandup: standup.list,
      subscribeStandup,
      standupSummary: standup.summary,
      setTaskPriority,
      list,
      subscribe,
      get,
      create,
      update,
      reportProgress,
      setCoordinator,
      start,
      setAppearance,
      markReportedRun,
      markTerminalNoticeRun,
      markOrphanNotified,
      listStored,
      coordinatorThreadId,
      coordinators,
      agentForThread,
      listAgents,
      subscribeAgents,
      createAgent,
      updateAgent,
      archiveAgent,
      startAgent,
    } satisfies FirstmateService["Service"];
  }),
);
