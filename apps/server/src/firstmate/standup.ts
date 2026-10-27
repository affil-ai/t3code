/**
 * The user's standup: tasks on any agent's board marked with a start date. A
 * standup task shows in the Standup section until it is done, monitoring, or
 * canceled, or is taken off. Only Firstmate's coordinator sets the mark, and
 * it may do so on any board; every other task field stays with the owner.
 *
 * Part of `FirstmateService`, which owns the change stream it publishes on.
 *
 * @module standup
 */
import {
  type AgentProfileId,
  FirstmateError,
  type FirstmateTask,
  type StandupListInput,
  type StandupMarkInput,
  type StandupSummary,
  type StandupTaskEntry,
  standupProgress,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { publicTask, type TaskRow, taskFromRow } from "./store.ts";

const FINISHED_STATUSES = ["done", "monitoring", "canceled"] as const;
const SUMMARY_TASK_LIMIT = 5;

const isFirstmateError = Schema.is(FirstmateError);
const fail = (message: string, cause?: unknown) =>
  new FirstmateError({ message, ...(cause === undefined ? {} : { cause }) });

const entry = (row: TaskRow): StandupTaskEntry => {
  const task = taskFromRow(row);
  return { agentId: task.agentId, task: publicTask(task) };
};

/**
 * Records when standup tasks finish, and clears it when one reopens. Runs at
 * startup and before every board change is published.
 */
export const syncStandupFinished = Effect.fn("Firstmate.syncStandupFinished")(function* (
  at: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE firstmate_task SET standup_finished_at = ${at}
    WHERE standup_started_at IS NOT NULL AND standup_finished_at IS NULL
      AND status IN ${sql.in(FINISHED_STATUSES)}
  `;
  yield* sql`
    UPDATE firstmate_task SET standup_finished_at = NULL
    WHERE standup_started_at IS NOT NULL AND standup_finished_at IS NOT NULL
      AND status NOT IN ${sql.in(FINISHED_STATUSES)}
  `;
});

export const makeStandup = Effect.fn("Firstmate.makeStandup")(function* (deps: {
  readonly now: () => Effect.Effect<string>;
  readonly notify: Effect.Effect<void>;
  readonly appendEvent: (
    taskId: FirstmateTask["id"],
    summary: string,
    at: string,
  ) => Effect.Effect<void, FirstmateError>;
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly agentNames: () => Effect.Effect<ReadonlyMap<string, string>, FirstmateError>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const dbError = (message: string) => (cause: unknown) =>
    isFirstmateError(cause) ? cause : fail(message, cause);

  const openTasks = () =>
    sql<TaskRow>`
      SELECT * FROM firstmate_task
      WHERE standup_started_at IS NOT NULL AND status NOT IN ${sql.in(FINISHED_STATUSES)}
      ORDER BY standup_started_at ASC, rowid ASC
    `.pipe(Effect.map((rows) => rows.map(entry)));

  /** Adds a task on any agent's board to the standup, or takes it off. */
  const mark = Effect.fn("Firstmate.standupMark")(
    function* (callerAgentId: AgentProfileId, input: StandupMarkInput) {
      const at = yield* deps.now();
      const agentId = input.agentId ?? callerAgentId;
      const rows =
        yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = ${input.taskId} AND agent_id = ${agentId}`;
      const row = rows[0];
      if (row === undefined) {
        return yield* fail(`Task ${input.taskId} is not on agent ${agentId}'s board.`);
      }
      const current = taskFromRow(row);
      if ((current.standup != null) === input.onStandup) return { task: publicTask(current) };
      if (input.onStandup) {
        yield* sql`
          UPDATE firstmate_task SET standup_started_at = ${at},
            standup_finished_at = CASE WHEN status IN ${sql.in(FINISHED_STATUSES)} THEN ${at} ELSE NULL END
          WHERE task_id = ${input.taskId}
        `;
      } else {
        yield* sql`
          UPDATE firstmate_task SET standup_started_at = NULL, standup_finished_at = NULL
          WHERE task_id = ${input.taskId}
        `;
      }
      yield* deps.appendEvent(
        input.taskId,
        input.onStandup ? "Added to standup." : "Removed from standup.",
        at,
      );
      const updated =
        yield* sql<TaskRow>`SELECT * FROM firstmate_task WHERE task_id = ${input.taskId}`;
      return { task: publicTask(taskFromRow(updated[0]!)) };
    },
    Effect.mapError(dbError("Could not change the standup.")),
    Effect.tap(() => deps.notify),
  );

  const list = (input: StandupListInput) =>
    Effect.all([
      openTasks(),
      input.includeFinished === true
        ? sql<TaskRow>`
            SELECT * FROM firstmate_task
            WHERE standup_started_at IS NOT NULL AND status IN ${sql.in(FINISHED_STATUSES)}
            ORDER BY standup_finished_at DESC, rowid DESC LIMIT 50
          `.pipe(Effect.map((rows) => rows.map(entry)))
        : Effect.succeed([]),
    ]).pipe(
      Effect.map(([open, finished]) => ({ tasks: [...open, ...finished] })),
      Effect.mapError(dbError("Could not list the standup.")),
    );

  /** The widget's view: counts and the first open tasks, with live worker activity. */
  const summary = Effect.fn("Firstmate.standupSummary")(function* () {
    const entries = yield* openTasks().pipe(
      Effect.mapError(dbError("Could not read the standup.")),
    );
    const names = yield* deps.agentNames();
    const progress = yield* Effect.forEach(entries, ({ task }) =>
      Effect.gen(function* () {
        const shell =
          task.workerThreadId === null
            ? null
            : yield* deps.threads
                .getThreadShell(task.workerThreadId)
                .pipe(Effect.orElseSucceed(() => null));
        return standupProgress(
          task,
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
      open: entries.length,
      needsYou: progress.filter((value) => value === "needs_you").length,
      running: progress.filter((value) => value === "running").length,
      tasks: entries.slice(0, SUMMARY_TASK_LIMIT).map(({ agentId, task }, index) => ({
        taskId: task.id,
        title: task.title,
        progress: progress[index] ?? "not_started",
        agentName: names.get(agentId) ?? "",
      })),
      generatedAt: yield* deps.now(),
    } satisfies StandupSummary;
  });

  return { mark, list, summary };
});
