import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { AgentProfileId, FIRSTMATE_AGENT_ID, StandupItemId } from "@t3tools/contracts";
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

const openStandup = (service: FirstmateService.FirstmateService["Service"]) =>
  service.subscribeStandup().pipe(
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.map(({ items }) => items),
  );

describe("standup", () => {
  it.effect("lists text-only and cross-agent items until their task finishes", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      yield* addJoan;
      const { task } = yield* service.create(JOAN, {
        title: "Page and link system",
        intent: "Simplify it",
        definitionOfDone: "Shipped",
        status: "in_progress",
        nextActor: "worker",
      });
      yield* service.addStandupItem(FM, { text: "upload hilton prices" });
      const linked = yield* service.addStandupItem(FM, {
        text: "simplify page/link system",
        agentId: JOAN,
        taskId: task.id,
      });
      expect(linked.item).toMatchObject({ agentId: JOAN, task: { id: task.id }, finishedAt: null });
      expect((yield* openStandup(service)).map((item) => item.text)).toEqual([
        "upload hilton prices",
        "simplify page/link system",
      ]);

      // Joan's coordinator moves it live; monitoring counts as finished.
      yield* service.update(JOAN, { taskId: task.id, summary: "Live", status: "monitoring" });
      expect((yield* openStandup(service)).map((item) => item.text)).toEqual([
        "upload hilton prices",
      ]);
      const finished = (yield* service.listStandup({ includeFinished: true })).items.find(
        (item) => item.id === linked.item.id,
      );
      expect(finished?.finishedAt).not.toBeNull();

      // Reopening the task brings the item back and clears its finish date.
      yield* service.update(JOAN, { taskId: task.id, summary: "Regressed", status: "in_progress" });
      const reopened = (yield* openStandup(service)).find((item) => item.id === linked.item.id);
      expect(reopened?.finishedAt).toBeNull();
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("closes items whose task finished before the service started", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create(FM, {
        title: "Shipped earlier",
        intent: "Ship it",
        definitionOfDone: "Live",
        status: "in_progress",
      });
      yield* service.update(FM, { taskId: task.id, summary: "Live", status: "monitoring" });
      // A row written before finishes were tracked: linked to a finished task, still open.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO firstmate_standup_item(item_id, text, agent_id, task_id, started_at)
        VALUES ('standup:old', 'shipped earlier', ${FM}, ${task.id}, '2026-10-26T16:00:00.000Z')
      `;
      const restarted = yield* FirstmateService.FirstmateService.pipe(
        Effect.provide(Layer.fresh(FirstmateService.layer)),
      );
      expect(yield* openStandup(restarted)).toEqual([]);
      const [finished] = (yield* restarted.listStandup({ includeFinished: true })).items;
      expect(finished).toMatchObject({ id: "standup:old", archivedAt: null });
      expect(finished?.finishedAt).not.toBeNull();
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("archives an item, keeping its dates for the finished list", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { item } = yield* service.addStandupItem(FM, { text: "resubmit ios app" });
      const archived = yield* service.archiveStandupItem({ itemId: item.id });
      expect(archived.item.archivedAt).not.toBeNull();
      expect(archived.item.finishedAt).toBe(archived.item.archivedAt);
      expect(yield* openStandup(service)).toEqual([]);
      expect((yield* service.listStandup({})).items).toEqual([]);
      expect((yield* service.listStandup({ includeFinished: true })).items).toEqual([
        archived.item,
      ]);
      const again = yield* service
        .updateStandupItem(FM, { itemId: item.id, text: "changed" })
        .pipe(Effect.flip);
      expect(again.message).toContain("archived");
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("links a task later, and rejects a task that is not on the named board", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      yield* addJoan;
      const { task } = yield* service.create(FM, {
        title: "Hilton prices",
        intent: "Upload them",
        definitionOfDone: "Uploaded",
      });
      const { item } = yield* service.addStandupItem(FM, { text: "upload hilton prices" });
      const wrongBoard = yield* service
        .updateStandupItem(FM, { itemId: item.id, agentId: JOAN, taskId: task.id })
        .pipe(Effect.flip);
      expect(wrongBoard.message).toContain("not on agent");
      const linked = yield* service.updateStandupItem(FM, { itemId: item.id, taskId: task.id });
      expect(linked.item).toMatchObject({ agentId: FM, task: { id: task.id } });
      const unlinked = yield* service.updateStandupItem(FM, { itemId: item.id, taskId: null });
      expect(unlinked.item).toMatchObject({ agentId: null, task: null });
      expect(
        yield* service.archiveStandupItem({ itemId: StandupItemId.make("standup:missing") }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        ),
      ).toContain("not found");
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("summarizes open items for the widget, with who acts next", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create(FM, {
        title: "Offer history",
        intent: "Finish it",
        definitionOfDone: "Done",
        status: "in_progress",
        nextActor: "user",
      });
      yield* service.addStandupItem(FM, { text: "finish offer history", taskId: task.id });
      yield* service.addStandupItem(FM, { text: "upload hilton prices" });
      const summary = yield* service.standupSummary();
      expect(summary).toMatchObject({
        open: 2,
        needsYou: 1,
        running: 0,
        items: [
          { text: "finish offer history", progress: "needs_you", agentName: "Firstmate" },
          { text: "upload hilton prices", progress: "not_started", agentName: null },
        ],
      });
    }).pipe(Effect.provide(layerFirstmate)),
  );
});
