import {
  CommandId,
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
  FirstmateTaskLink,
  FirstmateTaskArtifact,
  FirstmateSetAppearanceInput as AppearanceInput,
  MessageId,
  type ModelSelection,
  ProjectId,
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
  readonly artifacts_json: string;
  readonly close_evidence: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly last_reported_run_id: string | null;
  readonly orphan_notified_at: string | null;
}

interface ConfigRow {
  readonly coordinator_thread_id: string | null;
  readonly home_project_id: string | null;
  readonly name: string;
  readonly icon: string;
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
const artifactsJson = Schema.fromJsonString(Schema.Array(FirstmateTaskArtifact));
const decodeArtifacts = Schema.decodeUnknownSync(artifactsJson);
const encodeArtifacts = Schema.encodeSync(artifactsJson);
// Service callers are typed, but MCP and tests can bypass trimming; decode re-checks it.
const decodeCreateInput = Schema.decodeUnknownEffect(TaskCreateInput);
const decodeUpdateInput = Schema.decodeUnknownEffect(TaskUpdateInput);
const decodeAppearanceInput = Schema.decodeUnknownEffect(AppearanceInput);
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
    artifacts: decodeArtifacts(row.artifacts_json),
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
    /** Renames Firstmate and its coordinator chat, and sets its icon. */
    readonly setAppearance: (
      input: FirstmateSetAppearanceInput,
    ) => Effect.Effect<FirstmateSnapshot, ContractFirstmateError>;
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
    const home = yield* FirstmateHome.FirstmateHome;
    const launches = yield* ThreadLaunchService.ThreadLaunchService;
    const threads = yield* ThreadManagementService.ThreadManagementService;

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
    // Added after the first release; SQLite has no ADD COLUMN IF NOT EXISTS.
    const taskColumns = new Set(
      (yield* sql<{ name: string }>`PRAGMA table_info(firstmate_task)`).map((row) => row.name),
    );
    if (!taskColumns.has("artifacts_json")) {
      yield* sql.unsafe(
        `ALTER TABLE firstmate_task ADD COLUMN artifacts_json TEXT NOT NULL DEFAULT '[]'`,
      );
    }
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
    // Columns added after the first release. SQLite has no ADD COLUMN IF NOT
    // EXISTS, so check the table's shape and add only what is missing.
    const configColumns = new Set(
      (yield* sql<{ name: string }>`PRAGMA table_info(firstmate_config)`).map((row) => row.name),
    );
    if (!configColumns.has("name")) {
      yield* sql.unsafe(
        `ALTER TABLE firstmate_config ADD COLUMN name TEXT NOT NULL DEFAULT '${FIRSTMATE_DEFAULT_NAME}'`,
      );
    }
    if (!configColumns.has("icon")) {
      yield* sql.unsafe(
        `ALTER TABLE firstmate_config ADD COLUMN icon TEXT NOT NULL DEFAULT '${FIRSTMATE_DEFAULT_ICON}'`,
      );
    }
    if (!configColumns.has("home_project_id")) {
      yield* sql.unsafe(`ALTER TABLE firstmate_config ADD COLUMN home_project_id TEXT`);
    }
    yield* sql`INSERT OR IGNORE INTO firstmate_config(config_id, coordinator_thread_id) VALUES (1, NULL)`;

    const selectRows = (input?: FirstmateTaskListInput) => {
      if (input?.state !== undefined) {
        return sql<TaskRow>`SELECT * FROM firstmate_task WHERE state = ${input.state} ORDER BY updated_at DESC, task_id DESC`;
      }
      return sql<TaskRow>`SELECT * FROM firstmate_task WHERE state NOT IN ('done', 'dropped') ORDER BY updated_at DESC, task_id DESC`;
    };
    const readConfig = sql<ConfigRow>`
      SELECT coordinator_thread_id, home_project_id, name, icon FROM firstmate_config WHERE config_id = 1
    `.pipe(
      Effect.map(
        (rows): ConfigRow =>
          rows[0] ?? {
            coordinator_thread_id: null,
            home_project_id: null,
            name: FIRSTMATE_DEFAULT_NAME,
            icon: FIRSTMATE_DEFAULT_ICON,
          },
      ),
    );
    const readCoordinator = readConfig.pipe(Effect.map((row) => row.coordinator_thread_id));
    const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
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
      Effect.all({ config: readConfig, rows: readSnapshotTasks() }).pipe(
        Effect.map(
          ({ config, rows }) =>
            ({
              coordinatorThreadId:
                config.coordinator_thread_id === null
                  ? null
                  : ThreadId.make(config.coordinator_thread_id),
              homeProjectId:
                config.home_project_id === null ? null : ProjectId.make(config.home_project_id),
              name: config.name,
              icon: config.icon,
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
              artifacts: yield* keepArtifacts(taskId, input.artifacts ?? []),
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
            artifacts_json: encodeArtifacts(task.artifacts ?? []),
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
              artifacts: [
                ...(input.artifacts === undefined
                  ? (existing.artifacts ?? [])
                  : yield* keepArtifacts(existing.id, input.artifacts)),
                ...(yield* keepArtifacts(existing.id, input.addArtifacts ?? [])),
              ],
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
            artifacts_json = ${encodeArtifacts(next.artifacts ?? [])},
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
        const { name } = yield* readConfig.pipe(
          Effect.mapError((cause) => error("Could not read Firstmate settings.", undefined, cause)),
        );
        // The coordinator runs at the home project's root, so the provider
        // loads its AGENTS.md, notes, and skills like any project's.
        const { projectId } = yield* home.ensure({ name });
        yield* sql`UPDATE firstmate_config SET home_project_id = ${projectId} WHERE config_id = 1`.pipe(
          Effect.mapError((cause) =>
            error("Could not record the Firstmate project.", undefined, cause),
          ),
        );
        const launched = yield* launches.launch({
          commandId: CommandId.make(`firstmate:start:${yield* crypto.randomUUIDv4}`),
          projectId,
          title: name,
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            messageId: MessageId.make(`firstmate:prompt:${yield* crypto.randomUUIDv4}`),
            text: coordinatorKickoff(name),
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
    /** Renames the coordinator chat the way a thread rename does, when it still exists. */
    const renameCoordinator = (threadId: ThreadId, title: string) =>
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null || shell.title === title) return;
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`firstmate:rename:${yield* crypto.randomUUIDv4}`),
          threadId,
          title,
        });
      }).pipe(
        Effect.mapError((cause) => error("Could not rename the Firstmate chat.", undefined, cause)),
      );
    const setAppearance: FirstmateService["Service"]["setAppearance"] = (raw) =>
      Effect.gen(function* () {
        const input = yield* decodeAppearanceInput(raw);
        yield* sql`UPDATE firstmate_config SET name = ${input.name}, icon = ${input.icon} WHERE config_id = 1`;
        yield* notify;
        const coordinator = yield* readCoordinator;
        if (coordinator !== null) yield* renameCoordinator(ThreadId.make(coordinator), input.name);
        yield* home.rename(input.name);
        return yield* snapshot();
      }).pipe(
        Effect.mapError((cause) =>
          isFirstmateError(cause)
            ? cause
            : error("Could not save the Firstmate name and icon.", undefined, cause),
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
      setAppearance,
      markReportedRun,
      markOrphanNotified,
      listStored: readStored,
      coordinatorThreadId,
    } satisfies FirstmateService["Service"];
  }),
);
