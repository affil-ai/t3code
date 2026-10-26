import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Fork-owned column on the upstream `scheduled_tasks` table, added at service
 * start rather than by a numbered migration (see FORK.md). The default makes
 * existing tasks, and rows an upstream build inserts into the shared database,
 * steer their bound thread.
 */
export const ensureDeliveryModeColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some((column) => column.name === "delivery_mode")) return;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'steer'`;
});
