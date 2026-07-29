import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SQLITE_BUSY_TIMEOUT_MS, SqlitePersistenceMemory } from "./Sqlite.ts";

it.effect("waits through transient SQLite writer contention", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;

    assert.equal(row?.timeout, SQLITE_BUSY_TIMEOUT_MS);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
