/**
 * The user's standup list: to-dos that point at a task on any agent's board,
 * or at none. An item is listed until it is archived or its task finishes
 * (done, monitoring, or canceled). Only Firstmate's coordinator writes it.
 *
 * Part of `FirstmateService`, which owns the change stream it publishes on.
 *
 * @module standup
 */
import {
  type AgentProfileId,
  FirstmateError,
  type FirstmateTask,
  type StandupAddInput,
  type StandupArchiveInput,
  StandupItemId,
  type StandupItem,
  type StandupListInput,
  type StandupSummary,
  type StandupUpdateInput,
  standupProgress,
  standupTaskFinished,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { publicTask, type TaskRow, taskFromRow } from "./store.ts";

const FINISHED_STATUSES = ["done", "monitoring", "canceled"] as const;
const SUMMARY_ITEM_LIMIT = 5;

interface ItemRow extends Partial<TaskRow> {
  readonly item_id: string;
  readonly item_text: string;
  readonly item_agent_id: string | null;
  readonly started_at: string;
  readonly finished_at: string | null;
  readonly archived_at: string | null;
}

const ITEM_COLUMNS = `
  s.item_id, s.text AS item_text, s.agent_id AS item_agent_id,
  s.started_at, s.finished_at, s.archived_at, t.*
  FROM firstmate_standup_item s LEFT JOIN firstmate_task t ON t.task_id = s.task_id`;

function itemFromRow(row: ItemRow): StandupItem {
  return {
    id: StandupItemId.make(row.item_id),
    text: row.item_text,
    agentId: row.item_agent_id as AgentProfileId | null,
    task: row.task_id == null ? null : publicTask(taskFromRow(row as TaskRow)),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    archivedAt: row.archived_at,
  };
}

const isFirstmateError = Schema.is(FirstmateError);
const fail = (message: string, cause?: unknown) =>
  new FirstmateError({ message, ...(cause === undefined ? {} : { cause }) });

/**
 * Records when linked tasks finish, and clears it when one reopens. Runs
 * before every board change is published, so the list follows task updates.
 */
export const syncStandupFinished = Effect.fn("Firstmate.syncStandupFinished")(function* (
  at: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
      UPDATE firstmate_standup_item SET finished_at = ${at}
      WHERE finished_at IS NULL AND task_id IN (
        SELECT task_id FROM firstmate_task WHERE status IN ${sql.in(FINISHED_STATUSES)}
      )
    `;
  yield* sql`
      UPDATE firstmate_standup_item SET finished_at = NULL
      WHERE archived_at IS NULL AND finished_at IS NOT NULL AND task_id IN (
        SELECT task_id FROM firstmate_task WHERE status NOT IN ${sql.in(FINISHED_STATUSES)}
      )
    `;
});

export const makeStandup = Effect.fn("Firstmate.makeStandup")(function* (deps: {
  readonly now: () => Effect.Effect<string>;
  readonly notify: Effect.Effect<void>;
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly agentNames: () => Effect.Effect<ReadonlyMap<string, string>, FirstmateError>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const dbError = (message: string) => (cause: unknown) =>
    isFirstmateError(cause) ? cause : fail(message, cause);

  const readItem = (itemId: string) =>
    sql
      .unsafe<ItemRow>(`SELECT ${ITEM_COLUMNS} WHERE s.item_id = ?`, [itemId])
      .pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : itemFromRow(rows[0]))));
  const requireItem = (itemId: string) =>
    readItem(itemId).pipe(
      Effect.flatMap((item) =>
        item === undefined
          ? Effect.fail(fail(`Standup item ${itemId} was not found.`))
          : Effect.succeed(item),
      ),
    );
  const openItems = () =>
    sql
      .unsafe<ItemRow>(
        `SELECT ${ITEM_COLUMNS} WHERE s.archived_at IS NULL AND s.finished_at IS NULL ORDER BY s.started_at ASC, s.rowid ASC`,
      )
      .pipe(Effect.map((rows) => rows.map(itemFromRow)));
  const finishedItems = () =>
    sql
      .unsafe<ItemRow>(
        `SELECT ${ITEM_COLUMNS} WHERE s.archived_at IS NOT NULL OR s.finished_at IS NOT NULL ORDER BY COALESCE(s.finished_at, s.archived_at) DESC LIMIT 50`,
      )
      .pipe(Effect.map((rows) => rows.map(itemFromRow)));
  /** The linked task, which must be on `agentId`'s board. */
  const requireTask = (agentId: AgentProfileId, taskId: string) =>
    sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = ${taskId} AND agent_id = ${agentId}`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(fail(`Task ${taskId} is not on agent ${agentId}'s board.`))
          : Effect.succeed(publicTask(taskFromRow(rows[0]))),
      ),
    );
  const finishedAtFor = (task: FirstmateTask | null, previous: string | null, at: string) =>
    task !== null && standupTaskFinished(task) ? (previous ?? at) : null;

  const add = Effect.fn("Firstmate.standupAdd")(
    function* (callerAgentId: AgentProfileId, input: StandupAddInput) {
      const at = yield* deps.now();
      const agentId = input.taskId === undefined ? null : (input.agentId ?? callerAgentId);
      const task =
        input.taskId === undefined || agentId === null
          ? null
          : yield* requireTask(agentId, input.taskId);
      const itemId = `standup:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`;
      yield* sql`
        INSERT INTO firstmate_standup_item(item_id, text, agent_id, task_id, started_at, finished_at, archived_at)
        VALUES (${itemId}, ${input.text}, ${agentId}, ${task?.id ?? null}, ${at}, ${finishedAtFor(task, null, at)}, NULL)
      `;
      return { item: yield* requireItem(itemId) };
    },
    Effect.mapError(dbError("Could not add the standup item.")),
    Effect.tap(() => deps.notify),
  );

  const update = Effect.fn("Firstmate.standupUpdate")(
    function* (callerAgentId: AgentProfileId, input: StandupUpdateInput) {
      const at = yield* deps.now();
      const item = yield* requireItem(input.itemId);
      if (item.archivedAt !== null) {
        return yield* fail(`Standup item ${input.itemId} is archived; add a new one instead.`);
      }
      const relink = input.taskId !== undefined;
      const agentId = relink
        ? input.taskId === null
          ? null
          : (input.agentId ?? callerAgentId)
        : item.agentId;
      const task = !relink
        ? item.task
        : input.taskId === null || agentId === null
          ? null
          : yield* requireTask(agentId, input.taskId);
      yield* sql`
        UPDATE firstmate_standup_item SET
          text = ${input.text ?? item.text},
          agent_id = ${agentId},
          task_id = ${task?.id ?? null},
          finished_at = ${finishedAtFor(task, item.finishedAt, at)}
        WHERE item_id = ${input.itemId}
      `;
      return { item: yield* requireItem(input.itemId) };
    },
    Effect.mapError(dbError("Could not update the standup item.")),
    Effect.tap(() => deps.notify),
  );

  const archive = Effect.fn("Firstmate.standupArchive")(
    function* (input: StandupArchiveInput) {
      const at = yield* deps.now();
      const item = yield* requireItem(input.itemId);
      if (item.archivedAt !== null) return { item };
      yield* sql`
        UPDATE firstmate_standup_item SET archived_at = ${at}, finished_at = COALESCE(finished_at, ${at})
        WHERE item_id = ${input.itemId}
      `;
      return { item: yield* requireItem(input.itemId) };
    },
    Effect.mapError(dbError("Could not archive the standup item.")),
    Effect.tap(() => deps.notify),
  );

  const list = (input: StandupListInput) =>
    Effect.all([
      openItems(),
      input.includeFinished === true ? finishedItems() : Effect.succeed([]),
    ]).pipe(
      Effect.map(([open, finished]) => ({ items: [...open, ...finished] })),
      Effect.mapError(dbError("Could not list the standup.")),
    );

  const snapshot = () =>
    openItems().pipe(
      Effect.map((items) => ({ items })),
      Effect.mapError(dbError("Could not read the standup.")),
    );

  /** The widget's view: counts and the first open items, with live worker activity. */
  const summary = Effect.fn("Firstmate.standupSummary")(function* () {
    const items = yield* openItems().pipe(Effect.mapError(dbError("Could not read the standup.")));
    const names = yield* deps.agentNames();
    const progress = yield* Effect.forEach(items, (item) =>
      Effect.gen(function* () {
        const workerThreadId = item.task?.workerThreadId ?? null;
        const shell =
          workerThreadId === null
            ? null
            : yield* deps.threads
                .getThreadShell(workerThreadId)
                .pipe(Effect.orElseSucceed(() => null));
        return standupProgress(
          item.task,
          shell === null
            ? null
            : {
                active:
                  shell.activeRunId !== null ||
                  ["preparing", "queued", "starting", "running", "waiting"].includes(
                    shell.status,
                  ) ||
                  backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []),
                needsInput: shell.pendingRuntimeRequest !== null,
              },
        );
      }),
    );
    return {
      open: items.length,
      needsYou: progress.filter((value) => value === "needs_you").length,
      running: progress.filter((value) => value === "running").length,
      items: items.slice(0, SUMMARY_ITEM_LIMIT).map((item, index) => ({
        id: item.id,
        text: item.text,
        progress: progress[index] ?? "not_started",
        agentName: item.agentId === null ? null : (names.get(item.agentId) ?? null),
        startedAt: item.startedAt,
      })),
      generatedAt: yield* deps.now(),
    } satisfies StandupSummary;
  });

  return { add, update, archive, list, snapshot, summary };
});
