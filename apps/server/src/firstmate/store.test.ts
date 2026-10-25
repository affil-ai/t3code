import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { encodeProgress, ensureSchema, taskFromRow, type TaskRow } from "./store.ts";

it.effect("upgrades legacy agents without losing rows and supports old writers after upgrade", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureSchema;
    yield* sql.unsafe("ALTER TABLE firstmate_agent DROP COLUMN avatar_attachment_id");
    const before = yield* sql`SELECT * FROM firstmate_agent`;
    yield* ensureSchema;
    expect(yield* sql`SELECT agent_id FROM firstmate_agent`).toHaveLength(before.length);
    for (const row of before) {
      const [after] = yield* sql`SELECT * FROM firstmate_agent WHERE agent_id = ${row.agent_id}`;
      expect(after).toEqual({ ...row, avatar_attachment_id: null });
    }
    yield* sql`UPDATE firstmate_agent SET avatar_attachment_id = 'avatar-retained' WHERE agent_id = 'firstmate'`;
    // The previous runtime uses named columns for updates, leaving the new data intact.
    yield* sql`UPDATE firstmate_agent SET name = 'Chief' WHERE agent_id = 'firstmate'`;
    yield* ensureSchema;
    const [after] =
      yield* sql`SELECT name, avatar_attachment_id FROM firstmate_agent WHERE agent_id = 'firstmate'`;
    expect(after).toEqual({ name: "Chief", avatar_attachment_id: "avatar-retained" });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("migrates legacy statuses once and does not reclassify them on restart", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureSchema;
    // An older runtime can still insert rows without the new optional column.
    for (const [id, state, actor, expected] of [
      ["plan", "open", "coordinator", "planning"],
      ["work", "open", "user", "in_progress"],
      ["review", "waiting", "coordinator", "in_review"],
      ["ready", "ready", "coordinator", "ready_for_deployment"],
      ["done", "done", "user", "done"],
      ["cancel", "dropped", "coordinator", "canceled"],
    ]) {
      yield* sql`INSERT INTO firstmate_task
        (task_id, title, intent, definition_of_done, state, next_actor, note, links_json, created_at, updated_at)
        VALUES (${id}, 'Task', 'Request', 'Delivered', ${state}, ${actor}, '', '[]', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`;
      const [before] = yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = ${id}`;
      expect(taskFromRow(before!).status).toBe(expected);
    }
    yield* ensureSchema;
    expect(yield* sql`SELECT task_id FROM firstmate_task WHERE status IS NULL`).toHaveLength(0);
    yield* sql`UPDATE firstmate_task SET next_actor = 'worker' WHERE task_id = 'plan'`;
    yield* ensureSchema;
    const [after] = yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = 'plan'`;
    expect(taskFromRow(after!).status).toBe("planning");
    // A saved monitoring status is never reclassified from its legacy state.
    yield* sql`UPDATE firstmate_task SET status = 'monitoring' WHERE task_id = 'work'`;
    yield* ensureSchema;
    const [monitoring] = yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = 'work'`;
    expect(taskFromRow(monitoring!).status).toBe("monitoring");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("adds progress as a nullable column that older writers and readers leave intact", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* ensureSchema;
    // A database from before progress, as the previous runtime left it.
    yield* sql.unsafe("ALTER TABLE firstmate_task DROP COLUMN progress_json");
    yield* sql`INSERT INTO firstmate_task
      (task_id, title, intent, definition_of_done, state, status, next_actor, note, links_json, created_at, updated_at)
      VALUES ('climb', 'Recall', 'Request', 'Delivered', 'open', 'in_progress', 'worker', '', '[]', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`;
    yield* ensureSchema;
    yield* ensureSchema;
    const [migrated] = yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = 'climb'`;
    expect(migrated!.progress_json).toBeNull();
    expect(taskFromRow(migrated!).progress).toBeNull();

    const progress = {
      label: "Recall",
      kind: "metric",
      value: 87.5,
      unit: "%",
      updatedAt: "2026-10-24T10:00:00.000Z",
      history: [{ value: 87.5, at: "2026-10-24T10:00:00.000Z" }],
    } as const;
    yield* sql`UPDATE firstmate_task SET status = 'hillclimb', progress_json = ${encodeProgress(progress)} WHERE task_id = 'climb'`;
    // The previous runtime inserts by named columns and updates without progress_json.
    yield* sql`INSERT INTO firstmate_task
      (task_id, title, intent, definition_of_done, state, status, next_actor, note, links_json, created_at, updated_at)
      VALUES ('old', 'Old', 'Request', 'Delivered', 'open', 'planning', 'coordinator', '', '[]', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`;
    yield* sql`UPDATE firstmate_task SET title = 'Recall climb', note = 'Lane 2' WHERE task_id = 'climb'`;
    yield* ensureSchema;
    const [climb] = yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = 'climb'`;
    expect(taskFromRow(climb!)).toMatchObject({
      status: "hillclimb",
      title: "Recall climb",
      progress,
    });
    const [old] = yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = 'old'`;
    expect(taskFromRow(old!).progress).toBeNull();

    // A shape this build cannot read shows no progress instead of failing the board.
    yield* sql`UPDATE firstmate_task SET progress_json = '{"label":"Recall"}' WHERE task_id = 'old'`;
    const [unreadable] = yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = 'old'`;
    expect(taskFromRow(unreadable!).progress).toBeNull();
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
