import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { AgentProfileId, FIRSTMATE_AGENT_ID } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as FirstmateHome from "./FirstmateHome.ts";
import * as FirstmateService from "./FirstmateService.ts";

const FM = FIRSTMATE_AGENT_ID;
const JOAN = AgentProfileId.make("agent:joan");

const layerFirstmate = FirstmateService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.mock(FirstmateHome.FirstmateHome)({
        migrateLegacyHome: () => Effect.succeed(null),
        migrateAgentsFolder: () => Effect.succeed([]),
        artifactsRoot: "/agents/artifacts",
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      NodeCrypto.layer,
      NodeSqliteClient.layer({ filename: ":memory:" }),
    ),
  ),
);

const addJoan = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO firstmate_agent (agent_id, slug, name, icon, color, role, created_at)
    VALUES (${JOAN}, 'joan-of-affil', 'Joan of Affil', 'bot', 'sky', '', '2026-10-27T00:00:00.000Z')
  `;
});

const joanTask = (service: FirstmateService.FirstmateService["Service"]) =>
  service.create(JOAN, {
    title: "Page and link system",
    intent: "Simplify it",
    definitionOfDone: "Shipped",
    status: "in_progress",
    nextActor: "worker",
  });

const openStandup = (service: FirstmateService.FirstmateService["Service"]) =>
  service
    .listStandup({})
    .pipe(Effect.map(({ tasks }) => tasks.map(({ agent, task }) => [agent.id, task.title])));

describe("standup", () => {
  it.effect("marks another agent's task without changing its other fields", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      yield* addJoan;
      const { task } = yield* joanTask(service);
      const { task: marked } = yield* service.markStandup(FM, {
        agentId: JOAN,
        taskId: task.id,
        onStandup: true,
      });
      expect(marked.standup).toEqual({ startedAt: expect.any(String), finishedAt: null });
      expect({ ...marked, standup: null }).toEqual({ ...task, standup: null });
      expect(yield* openStandup(service)).toEqual([[JOAN, "Page and link system"]]);
      // Joan's own board carries the mark, so her sidebar shows it under Standup.
      const board = yield* service
        .subscribe(JOAN)
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      expect(board.tasks[0]?.standup?.startedAt).toBe(marked.standup?.startedAt);
      expect((yield* service.get(JOAN, { taskId: task.id })).events.at(-1)?.summary).toBe(
        "Added to standup.",
      );

      const wrongBoard = yield* service
        .markStandup(FM, { taskId: task.id, onStandup: true })
        .pipe(Effect.flip);
      expect(wrongBoard.message).toContain("not on agent");
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("finishes with the task, reopens with it, and comes off when unmarked", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      yield* addJoan;
      const { task } = yield* joanTask(service);
      yield* service.markStandup(FM, { agentId: JOAN, taskId: task.id, onStandup: true });

      // Joan's coordinator moves it live; monitoring counts as finished.
      yield* service.update(JOAN, { taskId: task.id, summary: "Live", status: "monitoring" });
      expect(yield* openStandup(service)).toEqual([]);
      const [finished] = (yield* service.listStandup({ includeFinished: true })).tasks;
      expect(finished?.task.standup?.finishedAt).not.toBeNull();

      yield* service.update(JOAN, { taskId: task.id, summary: "Regressed", status: "in_progress" });
      const [reopened] = (yield* service.listStandup({})).tasks;
      expect(reopened?.task.standup?.finishedAt).toBeNull();

      const { task: off } = yield* service.markStandup(FM, {
        agentId: JOAN,
        taskId: task.id,
        onStandup: false,
      });
      expect(off.standup).toBeNull();
      expect((yield* service.listStandup({ includeFinished: true })).tasks).toEqual([]);
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("keeps an archived owner's standup task, named, on every view", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      yield* addJoan;
      const { task } = yield* joanTask(service);
      yield* service.markStandup(FM, { agentId: JOAN, taskId: task.id, onStandup: true });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE firstmate_agent SET archived_at = '2026-10-27T18:00:00.000Z' WHERE agent_id = ${JOAN}`;

      // The sidebar's stream, the MCP list, and the widget all see the same task and owner.
      const streamed = yield* service
        .subscribeStandup()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      const listed = yield* service.listStandup({});
      expect(streamed).toEqual(listed);
      expect(listed.tasks).toMatchObject([
        {
          agent: { id: JOAN, name: "Joan of Affil", archivedAt: "2026-10-27T18:00:00.000Z" },
          task: { id: task.id },
        },
      ]);
      expect((yield* service.standupSummary()).tasks).toMatchObject([
        { taskId: task.id, agentName: "Joan of Affil" },
      ]);
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("records finishes that happened before the service started", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create(FM, {
        title: "Shipped earlier",
        intent: "Ship it",
        definitionOfDone: "Live",
        status: "in_progress",
      });
      yield* service.markStandup(FM, { taskId: task.id, onStandup: true });
      // A finish that no running service saw: status moved, finish date never written.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE firstmate_task SET status = 'done', state = 'done' WHERE task_id = ${task.id}`;
      const restarted = yield* FirstmateService.FirstmateService.pipe(
        Effect.provide(Layer.fresh(FirstmateService.layer)),
      );
      const [finished] = (yield* restarted.listStandup({ includeFinished: true })).tasks;
      expect(finished?.task.standup?.finishedAt).not.toBeNull();
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("summarizes open standup tasks for the widget", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const waiting = yield* service.create(FM, {
        title: "Offer history",
        intent: "Finish it",
        definitionOfDone: "Done",
        status: "in_progress",
        nextActor: "user",
      });
      const parked = yield* service.create(FM, {
        title: "Upload hilton prices",
        intent: "Upload them",
        definitionOfDone: "Uploaded",
        status: "backlog",
      });
      yield* service.markStandup(FM, { taskId: waiting.task.id, onStandup: true });
      yield* service.markStandup(FM, { taskId: parked.task.id, onStandup: true });
      expect(yield* service.standupSummary()).toMatchObject({
        open: 2,
        needsYou: 1,
        running: 0,
        tasks: [
          { title: "Offer history", progress: "needs_you", agentName: "Firstmate" },
          { title: "Upload hilton prices", progress: "not_started", agentName: "Firstmate" },
        ],
      });
    }).pipe(Effect.provide(layerFirstmate)),
  );
});
