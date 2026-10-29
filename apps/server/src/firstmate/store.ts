/**
 * The agent core's SQLite tables: their shape, the startup that creates them,
 * and the mapping between rows and tasks. The service owns the queries.
 *
 * Every task belongs to one agent. Firstmate is the reserved agent
 * `firstmate`; its rows predate the `agent_id` column and default to it.
 * The tables keep their `firstmate_` prefix so an installed database carries
 * over without a rename.
 *
 * The core intentionally does not use the numbered migration list. The
 * tables are fork-only and are safe to create on every service startup.
 *
 * @module store
 */
import {
  AGENT_DEFAULT_COLOR,
  type AgentProfile,
  AgentProfileId,
  FIRSTMATE_AGENT_ID,
  FIRSTMATE_DEFAULT_ICON,
  FIRSTMATE_DEFAULT_NAME,
  type FirstmateTask,
  type FirstmateTaskStatus,
  firstmateTaskStatus,
  FirstmateTaskArtifact,
  FirstmateTaskId,
  FirstmateTaskLink,
  FirstmateTaskProgress,
  ModelSelection,
  ProjectId,
  type ProjectIconColor,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** A task with the reactor's internal dedupe markers and its owner. */
export interface StoredTask extends FirstmateTask {
  readonly agentId: AgentProfileId;
  readonly lastReportedRunId: string | null;
  readonly lastTerminalNoticeRunId: string | null;
  readonly orphanNotifiedAt: string | null;
}

export interface TaskRow {
  readonly priority: number;
  readonly task_id: string;
  readonly agent_id: string;
  readonly title: string;
  readonly intent: string;
  readonly definition_of_done: string;
  readonly state: string;
  readonly status: string | null;
  readonly next_actor: string;
  readonly next_step: string | null;
  readonly note: string;
  readonly wake_at: string | null;
  readonly worker_thread_id: string | null;
  readonly links_json: string;
  readonly artifacts_json: string;
  readonly close_evidence: string | null;
  readonly progress_json: string | null;
  readonly standup_started_at?: string | null;
  readonly standup_finished_at?: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly last_reported_run_id: string | null;
  readonly last_terminal_notice_run_id: string | null;
  readonly orphan_notified_at: string | null;
}

export interface AgentRow {
  readonly agent_id: string;
  readonly slug: string;
  readonly name: string;
  readonly icon: string;
  readonly color: string;
  readonly avatar_attachment_id: string | null;
  readonly role: string;
  readonly coordinator_thread_id: string | null;
  readonly home_project_id: string | null;
  readonly model_selection_json: string | null;
  readonly created_at: string;
  readonly archived_at: string | null;
}

export interface EventRow {
  readonly event_id: string;
  readonly task_id: string;
  readonly created_at: string;
  readonly actor: string;
  readonly summary: string;
}

const linksJson = Schema.fromJsonString(Schema.Array(FirstmateTaskLink));
const decodeLinks = Schema.decodeUnknownSync(linksJson);
export const encodeLinks = Schema.encodeSync(linksJson);
const artifactsJson = Schema.fromJsonString(Schema.Array(FirstmateTaskArtifact));
const decodeArtifacts = Schema.decodeUnknownSync(artifactsJson);
export const encodeArtifacts = Schema.encodeSync(artifactsJson);
const progressJson = Schema.fromJsonString(FirstmateTaskProgress);
// A row a newer build wrote in a shape this one cannot read shows no progress
// rather than failing the board.
const decodeProgress = Schema.decodeUnknownOption(progressJson);
export const encodeProgress = (progress: FirstmateTaskProgress | null) =>
  progress === null ? null : Schema.encodeSync(progressJson)(progress);
const modelSelectionJson = Schema.fromJsonString(ModelSelection);
const decodeModelSelection = Schema.decodeUnknownOption(modelSelectionJson);
export const encodeModelSelection = Schema.encodeSync(modelSelectionJson);

export function taskFromRow(row: TaskRow): StoredTask {
  const status = firstmateTaskStatus({
    ...(row.status == null ? {} : { status: row.status as FirstmateTaskStatus }),
    state: row.state as FirstmateTask["state"],
    nextActor: row.next_actor as FirstmateTask["nextActor"],
  });
  return {
    id: FirstmateTaskId.make(row.task_id),
    priority: row.priority === 1,
    agentId: AgentProfileId.make(row.agent_id),
    title: row.title,
    intent: row.intent,
    definitionOfDone: row.definition_of_done,
    state: row.state as FirstmateTask["state"],
    status,
    nextActor: row.next_actor as FirstmateTask["nextActor"],
    nextStep: row.next_step,
    note: row.note,
    wakeAt: row.wake_at,
    workerThreadId: row.worker_thread_id === null ? null : ThreadId.make(row.worker_thread_id),
    links: decodeLinks(row.links_json),
    artifacts: decodeArtifacts(row.artifacts_json),
    closeEvidence: row.close_evidence,
    progress:
      row.progress_json == null ? null : Option.getOrNull(decodeProgress(row.progress_json)),
    standup:
      row.standup_started_at == null
        ? null
        : { startedAt: row.standup_started_at, finishedAt: row.standup_finished_at ?? null },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    lastReportedRunId: row.last_reported_run_id,
    lastTerminalNoticeRunId: row.last_terminal_notice_run_id,
    orphanNotifiedAt: row.orphan_notified_at,
  };
}

export function publicTask(task: StoredTask): FirstmateTask {
  const {
    agentId: _agent,
    lastReportedRunId: _last,
    lastTerminalNoticeRunId: _notice,
    orphanNotifiedAt: _orphan,
    ...visible
  } = task;
  return visible;
}

export function agentFromRow(row: AgentRow): AgentProfile {
  const model =
    row.model_selection_json === null ? null : decodeModelSelection(row.model_selection_json);
  return {
    id: AgentProfileId.make(row.agent_id),
    slug: row.slug,
    name: row.name,
    icon: row.icon,
    color: row.color as ProjectIconColor,
    ...(row.avatar_attachment_id === null ? {} : { avatarAttachmentId: row.avatar_attachment_id }),
    role: row.role,
    coordinatorThreadId:
      row.coordinator_thread_id === null ? null : ThreadId.make(row.coordinator_thread_id),
    homeProjectId: row.home_project_id === null ? null : ProjectId.make(row.home_project_id),
    modelSelection: model === null || model._tag === "None" ? null : model.value,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  } as AgentProfile;
}

const columnsOf = Effect.fn("columnsOf")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  return new Set(
    (yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`)).map((row) => row.name),
  );
});

/** Creates the tables, and any column added after the first release. */
export const ensureSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
  // Columns added after the first release; SQLite has no ADD COLUMN IF NOT EXISTS.
  const taskColumns = yield* columnsOf("firstmate_task");
  if (!taskColumns.has("priority")) {
    yield* sql.unsafe(`ALTER TABLE firstmate_task ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`);
  }
  if (!taskColumns.has("last_terminal_notice_run_id")) {
    yield* sql.unsafe(`ALTER TABLE firstmate_task ADD COLUMN last_terminal_notice_run_id TEXT`);
  }
  if (!taskColumns.has("next_step")) {
    yield* sql.unsafe(`ALTER TABLE firstmate_task ADD COLUMN next_step TEXT`);
  }
  if (!taskColumns.has("artifacts_json")) {
    yield* sql.unsafe(
      `ALTER TABLE firstmate_task ADD COLUMN artifacts_json TEXT NOT NULL DEFAULT '[]'`,
    );
  }
  if (!taskColumns.has("agent_id")) {
    // Every task before agents existed was Firstmate's.
    yield* sql.unsafe(
      `ALTER TABLE firstmate_task ADD COLUMN agent_id TEXT NOT NULL DEFAULT '${FIRSTMATE_AGENT_ID}'`,
    );
  }
  if (!taskColumns.has("status")) {
    yield* sql.unsafe(`ALTER TABLE firstmate_task ADD COLUMN status TEXT`);
  }
  // Nullable with no default, so an older build's INSERT, which names its
  // columns, still succeeds and its UPDATE leaves the progress alone.
  if (!taskColumns.has("progress_json")) {
    yield* sql.unsafe(`ALTER TABLE firstmate_task ADD COLUMN progress_json TEXT`);
  }
  // A standup task's dates; the start marks it as one. Nullable for older builds' writes.
  if (!taskColumns.has("standup_started_at")) {
    yield* sql.unsafe(`ALTER TABLE firstmate_task ADD COLUMN standup_started_at TEXT`);
  }
  if (!taskColumns.has("standup_finished_at")) {
    yield* sql.unsafe(`ALTER TABLE firstmate_task ADD COLUMN standup_finished_at TEXT`);
  }
  // Freeze the legacy classification once. A next-actor change after startup
  // must not move an existing task to another lifecycle section.
  yield* sql`
    UPDATE firstmate_task SET status = CASE
      WHEN state = 'done' THEN 'done'
      WHEN state = 'dropped' THEN 'canceled'
      WHEN state = 'ready' THEN 'ready_for_deployment'
      WHEN state = 'waiting' THEN 'in_review'
      WHEN next_actor = 'coordinator' THEN 'planning'
      WHEN next_actor = 'external' THEN 'in_review'
      ELSE 'in_progress' END
    WHERE status IS NULL
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS firstmate_task_state_updated ON firstmate_task(state, updated_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS firstmate_task_worker ON firstmate_task(worker_thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS firstmate_task_agent ON firstmate_task(agent_id, state, updated_at)`;
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
  // Firstmate's single settings row. It is read once below to seed the agent
  // table and is kept so an older build can still start against this database.
  yield* sql`
    CREATE TABLE IF NOT EXISTS firstmate_config (
      config_id INTEGER PRIMARY KEY CHECK (config_id = 1),
      coordinator_thread_id TEXT
    )
  `;
  const configColumns = yield* columnsOf("firstmate_config");
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
  yield* sql`
    CREATE TABLE IF NOT EXISTS firstmate_agent (
      agent_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      color TEXT NOT NULL,
      avatar_attachment_id TEXT,
      role TEXT NOT NULL,
      coordinator_thread_id TEXT,
      home_project_id TEXT,
      model_selection_json TEXT,
      created_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;
  // Firstmate becomes the first agent, carrying its chat, project, name, and
  // icon over from firstmate_config. After this the agent row is the truth.
  yield* sql`
    INSERT OR IGNORE INTO firstmate_agent
      (agent_id, slug, name, icon, color, role, coordinator_thread_id, home_project_id, model_selection_json, created_at, archived_at)
    SELECT ${FIRSTMATE_AGENT_ID}, ${FIRSTMATE_AGENT_ID}, name, icon, ${AGENT_DEFAULT_COLOR}, '',
      coordinator_thread_id, home_project_id, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
    FROM firstmate_config WHERE config_id = 1
  `;
  const agentColumns = yield* columnsOf("firstmate_agent");
  if (!agentColumns.has("avatar_attachment_id")) {
    yield* sql.unsafe(`ALTER TABLE firstmate_agent ADD COLUMN avatar_attachment_id TEXT`);
  }
});
