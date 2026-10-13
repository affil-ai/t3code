/**
 * Firstmate's SQLite tables: their shape, the startup that creates them, and
 * the mapping between rows and tasks. The service owns the queries.
 *
 * Firstmate intentionally does not use the numbered migration list. The
 * tables are fork-only and are safe to create on every service startup.
 *
 * @module store
 */
import {
  FIRSTMATE_DEFAULT_ICON,
  FIRSTMATE_DEFAULT_NAME,
  type FirstmateTask,
  FirstmateTaskArtifact,
  FirstmateTaskId,
  FirstmateTaskLink,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** A task with the reactor's internal dedupe markers. */
export interface StoredTask extends FirstmateTask {
  readonly lastReportedRunId: string | null;
  readonly orphanNotifiedAt: string | null;
}

export interface TaskRow {
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

export interface ConfigRow {
  readonly coordinator_thread_id: string | null;
  readonly home_project_id: string | null;
  readonly name: string;
  readonly icon: string;
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

function parseLinks(value: string): FirstmateTask["links"] {
  return decodeLinks(value);
}

export function taskFromRow(row: TaskRow): StoredTask {
  return {
    id: FirstmateTaskId.make(row.task_id),
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

export function publicTask(task: StoredTask): FirstmateTask {
  const { lastReportedRunId: _last, orphanNotifiedAt: _orphan, ...visible } = task;
  return visible;
}

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
});
