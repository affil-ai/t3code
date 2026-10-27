// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The fixture writes the server's SQLite file directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { SHOWCASE_SCENES } from "./mobile-showcase-environment.ts";
import {
  SHOWCASE_WORK_TASK_ID,
  seedShowcaseWork,
  writeShowcaseWorkArtifacts,
} from "./mobile-showcase-work.ts";

// Loaded by path: these modules belong to other packages' TypeScript projects.
const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
const fromRepo = (path: string) => NodePath.join(REPO_ROOT, path);

interface AppScenes {
  readonly SHOWCASE_SCENES: ReadonlyArray<string>;
  readonly SHOWCASE_WORK_TASK_ID: string;
}

interface ServerStore {
  readonly ensureSchema: Effect.Effect<void, SqlError, SqlClient.SqlClient>;
  readonly taskFromRow: (row: unknown) => {
    readonly id: string;
    readonly status: string;
    readonly nextActor: string;
    readonly workerThreadId: string | null;
    readonly progress: { readonly history: ReadonlyArray<unknown> } | null;
    readonly artifacts: ReadonlyArray<{ readonly kind: string; readonly url: string }>;
  };
  readonly agentFromRow: (row: unknown) => { readonly coordinatorThreadId: string | null };
}

it("keeps the app's scene list in step with the harness", async () => {
  const app = (await import(
    fromRepo("apps/mobile/src/features/showcase/showcaseScenes.ts")
  )) as AppScenes;
  assert.deepStrictEqual([...app.SHOWCASE_SCENES], [...SHOWCASE_SCENES]);
  assert.equal(app.SHOWCASE_WORK_TASK_ID, SHOWCASE_WORK_TASK_ID);
});

// A fixed clock keeps the seeded timestamps deterministic.
const NOW = Date.parse("2026-01-15T12:00:00.000Z");

it.effect("seeds Work rows the server's agent core can read", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-showcase-work-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const filename = NodePath.join(directory, "state.sqlite");
    const layer = NodeSqliteClient.layer({ filename });
    const store = (yield* Effect.promise(
      () => import(fromRepo("apps/server/src/firstmate/store.ts")),
    )) as ServerStore;
    const scheduledTasks = (
      (yield* Effect.promise(
        () =>
          import(
            fromRepo("apps/server/src/persistence/Migrations/OrchestrationV2/ScheduledTasks.ts")
          ),
      )) as { readonly default: Effect.Effect<void, SqlError, SqlClient.SqlClient> }
    ).default;
    yield* Effect.all([scheduledTasks, store.ensureSchema], { discard: true }).pipe(
      Effect.provide(layer),
    );

    const artifactsRoot = NodePath.join(directory, "artifacts");
    yield* Effect.promise(() => writeShowcaseWorkArtifacts(artifactsRoot));
    const database = new NodeSqlite.DatabaseSync(filename);
    try {
      seedShowcaseWork(database, NOW, {
        projectId: "t3code",
        workerThreadIds: ["handoff-haptics"],
        artifactsRoot,
      });
    } finally {
      database.close();
    }

    const { agents, tasks, automations } = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return {
        agents: (yield* sql`SELECT * FROM firstmate_agent`).map(store.agentFromRow),
        tasks: (yield* sql`SELECT * FROM firstmate_task`).map(store.taskFromRow),
        automations: yield* sql<{
          readonly thread_id: string;
          readonly next_run_at: string;
        }>`SELECT thread_id, next_run_at FROM scheduled_tasks`,
      };
    }).pipe(Effect.provide(layer));

    assert.isAbove(agents.length, 4);
    const detail = tasks.find((task) => task.id === SHOWCASE_WORK_TASK_ID);
    assert.equal(detail?.nextActor, "user");
    assert.equal(detail?.workerThreadId, "handoff-haptics");
    assert.isAbove(detail?.progress?.history.length ?? 0, 1);
    const image = detail?.artifacts.find((artifact) => artifact.kind === "image");
    assert.isDefined(image);
    yield* Effect.promise(() => NodeFSP.access(image!.url));
    assert.isTrue(tasks.some((task) => task.status === "backlog"));
    assert.isTrue(automations.length > 0);
    // Automations must not come due during a capture and start a provider turn.
    for (const automation of automations) {
      assert.isAbove(Date.parse(automation.next_run_at), NOW + 6 * 60 * 60_000);
    }
  }).pipe(Effect.scoped),
);
