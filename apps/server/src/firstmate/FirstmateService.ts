import {
  CommandId,
  FirstmateError as ContractFirstmateError,
  FirstmateSnapshot as ContractFirstmateSnapshot,
  FirstmateTask as ContractFirstmateTask,
  FirstmateTaskEvent as ContractFirstmateTaskEvent,
  FirstmateTaskEventId,
  FirstmateTaskId,
  FirstmateTaskCreateInput as TaskCreateInput,
  FirstmateTaskUpdateInput as TaskUpdateInput,
  FirstmateTaskListInput as TaskListInput,
  FirstmateTaskLink,
  MessageId,
  type ModelSelection,
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

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { defaultCoordinatorPrompt } from "./coordinatorPrompt.ts";

export type FirstmateTask = typeof ContractFirstmateTask.Type;
export type FirstmateTaskEvent = typeof ContractFirstmateTaskEvent.Type;
export type FirstmateSnapshot = typeof ContractFirstmateSnapshot.Type;

export type FirstmateTaskListInput = typeof TaskListInput.Type;
export type FirstmateTaskCreateInput = typeof TaskCreateInput.Type;
export type FirstmateTaskUpdateInput = typeof TaskUpdateInput.Type;
export interface FirstmateTaskGetInput {
  readonly taskId: FirstmateTask["id"];
}
export interface FirstmateSetCoordinatorInput {
  readonly threadId: ThreadId | null;
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

/** A task with the reactor's internal dedupe markers. */
export interface StoredTask extends FirstmateTask {
  readonly lastReportedRunId: string | null;
  readonly orphanNotifiedAt: string | null;
}

interface TaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly intent: string;
  readonly definition_of_done: string;
  readonly state: string;
  readonly next_actor: string;
  readonly note: string;
  readonly wake_at: string | null;
  readonly worker_thread_id: string | null;
  readonly links_json: string;
  readonly close_evidence: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly last_reported_run_id: string | null;
  readonly orphan_notified_at: string | null;
}

interface EventRow {
  readonly event_id: string;
  readonly task_id: string;
  readonly created_at: string;
  readonly actor: string;
  readonly summary: string;
}

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
const linksJson = Schema.fromJsonString(Schema.Array(FirstmateTaskLink));
const decodeLinks = Schema.decodeUnknownSync(linksJson);
const encodeLinks = Schema.encodeSync(linksJson);
// Service callers are typed, but MCP and tests can bypass trimming; decode re-checks it.
const decodeCreateInput = Schema.decodeUnknownEffect(TaskCreateInput);
const decodeUpdateInput = Schema.decodeUnknownEffect(TaskUpdateInput);
function parseLinks(value: string): FirstmateTask["links"] {
  return decodeLinks(value);
}

function taskFromRow(row: TaskRow): StoredTask {
  return {
    id: asTaskId(row.task_id),
    title: row.title,
    intent: row.intent,
    definitionOfDone: row.definition_of_done,
    state: row.state as FirstmateTask["state"],
    nextActor: row.next_actor as FirstmateTask["nextActor"],
    note: row.note,
    wakeAt: row.wake_at,
    workerThreadId: row.worker_thread_id === null ? null : ThreadId.make(row.worker_thread_id),
    links: parseLinks(row.links_json),
    closeEvidence: row.close_evidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    lastReportedRunId: row.last_reported_run_id,
    orphanNotifiedAt: row.orphan_notified_at,
  };
}

function publicTask(task: StoredTask): FirstmateTask {
  const { lastReportedRunId: _last, orphanNotifiedAt: _orphan, ...visible } = task;
  return visible;
}

export class FirstmateService extends Context.Service<
  FirstmateService,
  {
    readonly list: (
      input?: FirstmateTaskListInput,
    ) => Effect.Effect<{ readonly tasks: ReadonlyArray<FirstmateTask> }, ContractFirstmateError>;
    readonly subscribe: () => Stream.Stream<FirstmateSnapshot, ContractFirstmateError>;
    readonly get: (
      input: FirstmateTaskGetInput,
    ) => Effect.Effect<FirstmateTaskDetail, ContractFirstmateError>;
    readonly create: (
      input: FirstmateTaskCreateInput,
    ) => Effect.Effect<FirstmateTaskMutationResult, ContractFirstmateError>;
    readonly update: (
      input: FirstmateTaskUpdateInput,
    ) => Effect.Effect<FirstmateTaskMutationResult, ContractFirstmateError>;
    readonly setCoordinator: (
      input: FirstmateSetCoordinatorInput,
    ) => Effect.Effect<FirstmateSnapshot, ContractFirstmateError>;
    readonly start: (
      input: FirstmateStartInput,
    ) => Effect.Effect<FirstmateStartResult, ContractFirstmateError>;
    /** Internal reactor hook. It updates only the dedupe markers, not task history. */
    readonly markReportedRun: (
      taskId: FirstmateTask["id"],
      runId: string,
    ) => Effect.Effect<void, ContractFirstmateError>;
    readonly markOrphanNotified: (
      taskId: FirstmateTask["id"],
      at: string,
    ) => Effect.Effect<void, ContractFirstmateError>;
    readonly listStored: () => Effect.Effect<ReadonlyArray<StoredTask>, ContractFirstmateError>;
    readonly coordinatorThreadId: () => Effect.Effect<ThreadId | null, ContractFirstmateError>;
  }
>()("t3/firstmate/FirstmateService") {}

export const layer = Layer.effect(
  FirstmateService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const changes = yield* PubSub.sliding<void>(1);
    const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const launches = yield* ThreadLaunchService.ThreadLaunchService;

    // Firstmate intentionally does not use the numbered migration list. The
    // tables are fork-only and are safe to create on every service startup.
    yield* sql`
      CREATE TABLE IF NOT EXISTS firstmate_task (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        intent TEXT NOT NULL,
        definition_of_done TEXT NOT NULL,
        state TEXT NOT NULL,
        next_actor TEXT NOT NULL,
        note TEXT NOT NULL,
        wake_at TEXT,
        worker_thread_id TEXT,
        links_json TEXT NOT NULL,
        close_evidence TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        last_reported_run_id TEXT,
        orphan_notified_at TEXT
      )
    `;
    yield* sql`CREATE INDEX IF NOT EXISTS firstmate_task_state_updated ON firstmate_task(state, updated_at)`;
    yield* sql`CREATE INDEX IF NOT EXISTS firstmate_task_worker ON firstmate_task(worker_thread_id)`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS firstmate_task_event (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        summary TEXT NOT NULL
      )
    `;
    yield* sql`CREATE INDEX IF NOT EXISTS firstmate_task_event_task ON firstmate_task_event(task_id, created_at)`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS firstmate_config (
        config_id INTEGER PRIMARY KEY CHECK (config_id = 1),
        coordinator_thread_id TEXT
      )
    `;
    yield* sql`INSERT OR IGNORE INTO firstmate_config(config_id, coordinator_thread_id) VALUES (1, NULL)`;

    const selectRows = (input?: FirstmateTaskListInput) => {
      if (input?.state !== undefined) {
        return sql<TaskRow>`SELECT * FROM firstmate_task WHERE state = ${input.state} ORDER BY updated_at DESC, task_id DESC`;
      }
      return sql<TaskRow>`SELECT * FROM firstmate_task WHERE state NOT IN ('done', 'dropped') ORDER BY updated_at DESC, task_id DESC`;
    };
    const readCoordinator = sql<{ coordinator_thread_id: string | null }>`
      SELECT coordinator_thread_id FROM firstmate_config WHERE config_id = 1
    `.pipe(Effect.map((rows) => rows[0]?.coordinator_thread_id ?? null));
    const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    const readStored = (): Effect.Effect<ReadonlyArray<StoredTask>, ContractFirstmateError> =>
      selectRows().pipe(
        Effect.map((rows) => rows.map(taskFromRow)),
        Effect.mapError((cause) => error("Could not list Firstmate tasks.", undefined, cause)),
      );
    const readSnapshotTasks = (): Effect.Effect<
      ReadonlyArray<StoredTask>,
      ContractFirstmateError
    > =>
      Effect.all({
        open: sql<TaskRow>`
          SELECT * FROM firstmate_task
          WHERE state NOT IN ('done', 'dropped')
          ORDER BY updated_at DESC, task_id DESC
        `,
        closed: sql<TaskRow>`
          SELECT * FROM firstmate_task
          WHERE state IN ('done', 'dropped')
          ORDER BY closed_at DESC, updated_at DESC, task_id DESC
          LIMIT 20
        `,
      }).pipe(
        Effect.map(({ open, closed }) => [...open, ...closed].map(taskFromRow)),
        Effect.mapError((cause) =>
          error("Could not read Firstmate tasks for the board.", undefined, cause),
        ),
      );
    const snapshot = (): Effect.Effect<FirstmateSnapshot, ContractFirstmateError> =>
      Effect.all({ coordinatorThreadId: readCoordinator, rows: readSnapshotTasks() }).pipe(
        Effect.map(
          ({ coordinatorThreadId, rows }) =>
            ({
              coordinatorThreadId:
                coordinatorThreadId === null ? null : ThreadId.make(coordinatorThreadId),
              tasks: rows.map(publicTask),
            }) as FirstmateSnapshot,
        ),
        Effect.mapError((cause) =>
          isFirstmateError(cause)
            ? cause
            : error("Could not read Firstmate state.", undefined, cause),
        ),
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
        Effect.mapError((cause) => error("Could not read Firstmate task events.", taskId, cause)),
      );
    const appendEvent = (
      taskId: FirstmateTask["id"],
      summary: string,
      actor: FirstmateTaskEvent["actor"],
      at: string,
    ) =>
      Effect.gen(function* () {
        const eventId = `firstmate-event:${yield* crypto.randomUUIDv4}`;
        yield* sql`
          INSERT INTO firstmate_task_event(event_id, task_id, created_at, actor, summary)
          VALUES (${eventId}, ${taskId}, ${at}, ${actor}, ${summary})
        `.pipe(
          Effect.mapError((cause) =>
            error("Could not record Firstmate task event.", taskId, cause),
          ),
        );
      });

    const list: FirstmateService["Service"]["list"] = (input) =>
      selectRows(input).pipe(
        Effect.map((rows) => ({ tasks: rows.map(taskFromRow).map(publicTask) })),
        Effect.mapError((cause) => error("Could not list Firstmate tasks.", undefined, cause)),
      );
    const subscribe: FirstmateService["Service"]["subscribe"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(snapshot()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot())),
          );
        }),
      );
    const get: FirstmateService["Service"]["get"] = (input) =>
      Effect.gen(function* () {
        const rows =
          yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = ${input.taskId}`;
        const row = rows[0];
        if (row === undefined) return yield* error("Firstmate task was not found.", input.taskId);
        return { task: publicTask(taskFromRow(row)), events: yield* eventsFor(input.taskId) };
      }).pipe(
        Effect.mapError((cause) =>
          isFirstmateError(cause)
            ? cause
            : error("Could not get Firstmate task.", input.taskId, cause),
        ),
      );
    const create: FirstmateService["Service"]["create"] = (raw) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const input = yield* decodeCreateInput(raw);
            const now = DateTime.formatIso(DateTime.toUtc(yield* isoNow));
            const taskId = asTaskId(`firstmate-task:${yield* crypto.randomUUIDv4}`);
            const task: StoredTask = {
              id: taskId,
              title: input.title,
              intent: input.intent,
              definitionOfDone: input.definitionOfDone,
              state: "open",
              nextActor: input.nextActor ?? "coordinator",
              note: input.note ?? "",
              wakeAt: input.wakeAt ?? null,
              workerThreadId: input.workerThreadId ?? null,
              links: input.links ?? [],
              closeEvidence: null,
              createdAt: now,
              updatedAt: now,
              closedAt: null,
              lastReportedRunId: null,
              orphanNotifiedAt: null,
            };
            yield* sql`
          INSERT INTO firstmate_task ${sql.insert({
            task_id: task.id,
            title: task.title,
            intent: task.intent,
            definition_of_done: task.definitionOfDone,
            state: task.state,
            next_actor: task.nextActor,
            note: task.note,
            wake_at: task.wakeAt,
            worker_thread_id: task.workerThreadId,
            links_json: encodeLinks(task.links),
            close_evidence: task.closeEvidence,
            created_at: task.createdAt,
            updated_at: task.updatedAt,
            closed_at: task.closedAt,
            last_reported_run_id: task.lastReportedRunId,
            orphan_notified_at: task.orphanNotifiedAt,
          })}
        `.pipe(
              Effect.mapError((cause) => error("Could not create Firstmate task.", task.id, cause)),
            );
            yield* appendEvent(task.id, input.summary ?? "Task created.", "coordinator", now);
            return { task: publicTask(task) };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isFirstmateError(cause)
              ? cause
              : error("Could not create Firstmate task.", undefined, cause),
          ),
          Effect.tap(() => notify),
        );
    const update: FirstmateService["Service"]["update"] = (raw) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const input = yield* decodeUpdateInput(raw);
            const rows =
              yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = ${input.taskId}`;
            const existing = rows[0] === undefined ? undefined : taskFromRow(rows[0]);
            if (existing === undefined)
              return yield* error("Firstmate task was not found.", input.taskId);
            const nextState = input.state ?? existing.state;
            const closing = nextState === "done" || nextState === "dropped";
            const evidence =
              input.closeEvidence === undefined ? existing.closeEvidence : input.closeEvidence;
            if (closing && (evidence === null || evidence.trim() === ""))
              return yield* error("Closing a Firstmate task requires closeEvidence.", input.taskId);
            const now = DateTime.formatIso(DateTime.toUtc(yield* isoNow));
            const next: StoredTask = {
              ...existing,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.intent === undefined ? {} : { intent: input.intent }),
              ...(input.definitionOfDone === undefined
                ? {}
                : { definitionOfDone: input.definitionOfDone }),
              state: nextState,
              ...(input.nextActor === undefined ? {} : { nextActor: input.nextActor }),
              ...(input.note === undefined ? {} : { note: input.note }),
              ...(input.wakeAt === undefined ? {} : { wakeAt: input.wakeAt }),
              ...(input.workerThreadId === undefined
                ? {}
                : { workerThreadId: input.workerThreadId }),
              ...(input.links === undefined ? {} : { links: input.links }),
              closeEvidence: evidence,
              updatedAt: now,
              closedAt: closing ? (existing.closedAt ?? now) : null,
              orphanNotifiedAt: null,
            };
            yield* sql`
          UPDATE firstmate_task SET
            title = ${next.title}, intent = ${next.intent}, definition_of_done = ${next.definitionOfDone},
            state = ${next.state}, next_actor = ${next.nextActor}, note = ${next.note}, wake_at = ${next.wakeAt},
            worker_thread_id = ${next.workerThreadId}, links_json = ${encodeLinks(next.links)},
            close_evidence = ${next.closeEvidence}, updated_at = ${next.updatedAt}, closed_at = ${next.closedAt},
            orphan_notified_at = NULL
          WHERE task_id = ${next.id}
        `.pipe(
              Effect.mapError((cause) => error("Could not update Firstmate task.", next.id, cause)),
            );
            yield* appendEvent(next.id, input.summary, "coordinator", now);
            return { task: publicTask(next) };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isFirstmateError(cause)
              ? cause
              : error("Could not update Firstmate task.", raw.taskId, cause),
          ),
          Effect.tap(() => notify),
        );
    const setCoordinator: FirstmateService["Service"]["setCoordinator"] = (input) =>
      sql`UPDATE firstmate_config SET coordinator_thread_id = ${input.threadId} WHERE config_id = 1`.pipe(
        Effect.mapError((cause) =>
          error("Could not set the Firstmate coordinator.", undefined, cause),
        ),
        Effect.andThen(notify),
        Effect.andThen(snapshot()),
      );
    const start: FirstmateService["Service"]["start"] = (input) =>
      Effect.gen(function* () {
        // Like an MCP `scratch: true` launch: the coordinator lives in the
        // Scratch project, and a root launch there claims its own folder.
        const { projectId } = yield* folders.ensureScratchProject.pipe(
          Effect.mapError((cause) => error(cause.message, undefined, cause)),
        );
        const launched = yield* launches.launch({
          commandId: CommandId.make(`firstmate:start:${yield* crypto.randomUUIDv4}`),
          projectId,
          title: "Firstmate",
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make(`firstmate:prompt:${yield* crypto.randomUUIDv4}`),
            text: defaultCoordinatorPrompt,
            attachments: [],
          },
          createdBy: "user",
          creationSource: "web",
        });
        return yield* setCoordinator({ threadId: launched.threadId }).pipe(
          Effect.map((snapshot) => ({ threadId: launched.threadId, snapshot })),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isFirstmateError(cause) ? cause : error("Could not start Firstmate.", undefined, cause),
        ),
      );
    const markReportedRun: FirstmateService["Service"]["markReportedRun"] = (taskId, runId) =>
      sql`UPDATE firstmate_task SET last_reported_run_id = ${runId}, updated_at = updated_at WHERE task_id = ${taskId}`.pipe(
        Effect.mapError((cause) => error("Could not record the Firstmate wake.", taskId, cause)),
        Effect.asVoid,
      );
    const markOrphanNotified: FirstmateService["Service"]["markOrphanNotified"] = (taskId, at) =>
      sql`UPDATE firstmate_task SET orphan_notified_at = ${at} WHERE task_id = ${taskId}`.pipe(
        Effect.mapError((cause) =>
          error("Could not record the Firstmate orphan wake.", taskId, cause),
        ),
        Effect.asVoid,
      );

    const coordinatorThreadId: FirstmateService["Service"]["coordinatorThreadId"] = () =>
      readCoordinator.pipe(
        Effect.map((value) => (value === null ? null : ThreadId.make(value))),
        Effect.mapError((cause) =>
          error("Could not read the Firstmate coordinator.", undefined, cause),
        ),
      );

    return {
      list,
      subscribe,
      get,
      create,
      update,
      setCoordinator,
      start,
      markReportedRun,
      markOrphanNotified,
      listStored: readStored,
      coordinatorThreadId,
    } satisfies FirstmateService["Service"];
  }),
);
