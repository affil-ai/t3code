import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  FirstmateError,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { coordinatorKickoff } from "./coordinatorPrompt.ts";
import * as FirstmateHome from "./FirstmateHome.ts";
import * as FirstmateService from "./FirstmateService.ts";

const coordinator = ThreadId.make("firstmate-coordinator");

const layerDependencies = Layer.mergeAll(
  Layer.mock(FirstmateHome.FirstmateHome)({
    rename: () => Effect.void,
    keepImage: ({ taskId, path }) => Effect.succeed(`/kept/${taskId}/${path.split("/").pop()}`),
  }),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  NodeCrypto.layer,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

const layerFirstmate = FirstmateService.layer.pipe(Layer.provide(layerDependencies));

const snapshot = Effect.fn("firstmateSnapshotTestHelper")(function* (
  service: FirstmateService.FirstmateService["Service"],
) {
  return yield* service.subscribe().pipe(Stream.runHead, Effect.map(Option.getOrThrow));
});

describe("FirstmateService", () => {
  it.effect("starts unconfigured, sets and clears the coordinator", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      expect((yield* snapshot(service)).coordinatorThreadId).toBeNull();
      expect((yield* service.setCoordinator({ threadId: coordinator })).coordinatorThreadId).toBe(
        coordinator,
      );
      expect((yield* service.setCoordinator({ threadId: null })).coordinatorThreadId).toBeNull();
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("rejects blank create fields and update summaries without appending events", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      expect(
        yield* service
          .create({ title: " ", intent: "Request", definitionOfDone: "Delivered" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "FirstmateError" });
      expect((yield* service.list()).tasks).toHaveLength(0);
      const { task } = yield* service.create({
        title: "Valid",
        intent: "  Keep my words.  ",
        definitionOfDone: "Delivered",
      });
      expect(task.intent).toBe("  Keep my words.  ");
      expect(
        yield* service
          .update({ taskId: task.id, summary: " ", title: "Changed" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "FirstmateError" });
      const detail = yield* service.get({ taskId: task.id });
      expect(detail.task.title).toBe("Valid");
      expect(detail.events).toHaveLength(1);
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("keeps review artifacts, copying images, and appends or replaces them", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create({
        title: "Dashboards",
        intent: "Build them",
        definitionOfDone: "Merged",
        artifacts: [{ kind: "link", label: "PR #1", url: "https://example.com/pull/1" }],
      });
      expect(task.artifacts).toEqual([
        { kind: "link", label: "PR #1", url: "https://example.com/pull/1" },
      ]);
      const added = yield* service.update({
        taskId: task.id,
        summary: "Added a screenshot.",
        addArtifacts: [
          {
            kind: "image",
            label: "Board",
            url: "/worktree/shots/board.png",
            caption: "Check the empty column",
          },
        ],
      });
      expect(added.task.artifacts).toEqual([
        { kind: "link", label: "PR #1", url: "https://example.com/pull/1" },
        {
          kind: "image",
          label: "Board",
          url: `/kept/${task.id}/board.png`,
          caption: "Check the empty column",
        },
      ]);
      // Untouched by an update that names neither field.
      const renamed = yield* service.update({ taskId: task.id, summary: "Retitled.", title: "B" });
      expect(renamed.task.artifacts).toHaveLength(2);
      const replaced = yield* service.update({
        taskId: task.id,
        summary: "New round.",
        artifacts: [{ kind: "link", label: "Preview", url: "https://example.com/preview" }],
      });
      expect(replaced.task.artifacts?.map((artifact) => artifact.label)).toEqual(["Preview"]);
      expect((yield* service.get({ taskId: task.id })).task.artifacts).toHaveLength(1);
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("retains open-only list defaults and logs worker replacement", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create({
        title: "Task",
        intent: "Request",
        definitionOfDone: "Delivered",
        workerThreadId: ThreadId.make("worker-1"),
      });
      yield* service.update({
        taskId: task.id,
        workerThreadId: ThreadId.make("worker-2"),
        summary: "Replaced the worker.",
      });
      const detail = yield* service.get({ taskId: task.id });
      expect(detail.task.workerThreadId).toBe("worker-2");
      expect(detail.events.map((event) => event.summary)).toEqual([
        "Task created.",
        "Replaced the worker.",
      ]);
      yield* service.update({
        taskId: task.id,
        state: "dropped",
        closeEvidence: "User asked to stop.",
        summary: "Dropped with approval.",
      });
      expect((yield* service.list()).tasks).toHaveLength(0);
      expect((yield* service.list({ state: "dropped" })).tasks).toHaveLength(1);
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("creates tasks and appends a typed event", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const result = yield* service.create({
        title: "Ship the board",
        intent: "Build the Firstmate board exactly as requested.",
        definitionOfDone: "The board is available in the web app.",
        nextActor: "worker",
        note: "Queued",
        workerThreadId: ThreadId.make("worker-1"),
        summary: "Recorded the board task.",
      });
      const detail = yield* service.get({ taskId: result.task.id });
      expect(detail.task).toMatchObject({
        id: result.task.id,
        title: "Ship the board",
        nextActor: "worker",
        state: "open",
      });
      expect(detail.events).toHaveLength(1);
      expect(detail.events[0]).toMatchObject({
        taskId: result.task.id,
        actor: "coordinator",
        summary: "Recorded the board task.",
      });
      assert(typeof detail.events[0]!.id === "string");
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("requires close evidence and clears closedAt when reopened", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const created = yield* service.create({
        title: "Close me",
        intent: "Demonstrate close validation.",
        definitionOfDone: "The close path is tested.",
      });
      const invalid = yield* service
        .update({
          taskId: created.task.id,
          state: "done",
          summary: "Attempted to close without evidence.",
        })
        .pipe(Effect.flip);
      expect(invalid).toMatchObject({ _tag: "FirstmateError" });

      const closed = yield* service.update({
        taskId: created.task.id,
        state: "done",
        closeEvidence: "The user accepted the delivered result.",
        summary: "Closed with user acceptance.",
      });
      expect(closed.task.state).toBe("done");
      expect(closed.task.closedAt).not.toBeNull();
      expect(closed.task.closeEvidence).toBe("The user accepted the delivered result.");

      const reopened = yield* service.update({
        taskId: created.task.id,
        state: "open",
        summary: "Reopened for follow-up.",
      });
      expect(reopened.task.state).toBe("open");
      expect(reopened.task.closedAt).toBeNull();
      expect(reopened.task.closeEvidence).toBe("The user accepted the delivered result.");
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("streams every open task and only the newest 20 closed tasks", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const open = yield* service.create({
        title: "Still open",
        intent: "Remain visible on the board.",
        definitionOfDone: "It is not closed.",
      });
      const closed: FirstmateService.FirstmateTask[] = [];
      for (let index = 0; index < 22; index += 1) {
        const created = yield* service.create({
          title: `Closed ${index}`,
          intent: `Closed task ${index}.`,
          definitionOfDone: "The task is closed.",
        });
        const result = yield* service.update({
          taskId: created.task.id,
          state: "done",
          closeEvidence: `Evidence ${index}`,
          summary: `Closed task ${index}.`,
        });
        closed.push(result.task);
        yield* TestClock.adjust("1 second");
      }
      const current = yield* snapshot(service);
      expect(current.tasks).toHaveLength(21);
      expect(current.tasks.some((task) => task.id === open.task.id)).toBe(true);
      const visibleClosed = current.tasks.filter((task) => task.state === "done");
      expect(visibleClosed).toHaveLength(20);
      expect(visibleClosed.map((task) => task.title)).toEqual(
        closed
          .slice(-20)
          .toReversed()
          .map((task) => task.title),
      );
      expect(current.tasks.every((task) => task.state !== "dropped")).toBe(true);
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("start launches the coordinator at the root of the Firstmate home project", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:firstmate-home");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      const ensured: string[] = [];
      const launched: ThreadLaunchService.ThreadLaunchInput[] = [];
      const layer = FirstmateService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(FirstmateHome.FirstmateHome)({
              ensure: ({ name }) => {
                ensured.push(name);
                return Effect.succeed({ projectId });
              },
              rename: () => Effect.void,
              keepImage: ({ path }) => Effect.succeed(path),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: (input) => {
                launched.push(input);
                return Effect.succeed({
                  threadId: ThreadId.make("launched-coordinator"),
                } as ThreadLaunchService.ThreadLaunchResult);
              },
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(null),
            }),
            NodeCrypto.layer,
            NodeSqliteClient.layer({ filename: ":memory:" }),
          ),
        ),
      );
      const context = yield* Layer.build(layer);
      const service = yield* FirstmateService.FirstmateService.pipe(Effect.provide(context));
      yield* service.setAppearance({ name: "Jarvis", icon: "bot" });
      const result = yield* service.start({ modelSelection });
      expect(result.threadId).toBe("launched-coordinator");
      expect(result.snapshot.coordinatorThreadId).toBe("launched-coordinator");
      // The home project is titled, and the kickoff written, with the custom name.
      expect(ensured).toEqual(["Jarvis"]);
      expect(launched).toHaveLength(1);
      expect(launched[0]).toMatchObject({
        projectId,
        title: "Jarvis",
        modelSelection,
        workspaceStrategy: { type: "root" },
        initialMessage: { text: coordinatorKickoff("Jarvis"), attachments: [] },
      });
      expect(launched[0]!.initialMessage!.text).toMatch(/^You are Jarvis\. .*AGENTS\.md/);
      // A fresh thread: no threadId requested and no reuse.
      expect(launched[0]!.threadId).toBeUndefined();
      expect(launched[0]!.reuseExistingThread).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("start fails without launching when the home folder cannot be set up", () =>
    Effect.gen(function* () {
      const launched: ThreadLaunchService.ThreadLaunchInput[] = [];
      const layer = FirstmateService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(FirstmateHome.FirstmateHome)({
              ensure: () =>
                Effect.fail(
                  new FirstmateError({ message: "Could not set up the Firstmate folder." }),
                ),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: (input) => {
                launched.push(input);
                return Effect.die("unexpected launch");
              },
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({}),
            NodeCrypto.layer,
            NodeSqliteClient.layer({ filename: ":memory:" }),
          ),
        ),
      );
      const context = yield* Layer.build(layer);
      const service = yield* FirstmateService.FirstmateService.pipe(Effect.provide(context));
      const failure = yield* service
        .start({ modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" } })
        .pipe(Effect.flip);
      expect(failure.message).toBe("Could not set up the Firstmate folder.");
      expect(launched).toHaveLength(0);
      expect((yield* snapshot(service)).coordinatorThreadId).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("defaults the name and icon and saves new ones for every subscriber", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      expect(yield* snapshot(service)).toMatchObject({ name: "Firstmate", icon: "compass" });
      const saved = yield* service.setAppearance({ name: "  Jarvis ", icon: "rocket" });
      expect(saved).toMatchObject({ name: "Jarvis", icon: "rocket" });
      expect(yield* snapshot(service)).toMatchObject({ name: "Jarvis", icon: "rocket" });
      expect(
        yield* service.setAppearance({ name: " ", icon: "rocket" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "FirstmateError" });
      expect(yield* snapshot(service)).toMatchObject({ name: "Jarvis" });
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("renames the coordinator chat and the home project", () =>
    Effect.gen(function* () {
      const dispatched: OrchestrationV2ServerCommand[] = [];
      const projectRenames: string[] = [];
      const titles = new Map<string, string>([[coordinator, "Firstmate"]]);
      const layer = FirstmateService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(FirstmateHome.FirstmateHome)({
              rename: (name) => Effect.sync(() => void projectRenames.push(name)),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed(
                  titles.has(threadId)
                    ? ({
                        id: threadId,
                        title: titles.get(threadId),
                        deletedAt: null,
                      } as OrchestrationV2ThreadShell)
                    : null,
                ),
              dispatch: (command) => {
                dispatched.push(command);
                return Effect.succeed({} as Orchestrator.OrchestratorV2DispatchResult);
              },
            }),
            NodeCrypto.layer,
            NodeSqliteClient.layer({ filename: ":memory:" }),
          ),
        ),
      );
      const context = yield* Layer.build(layer);
      const service = yield* FirstmateService.FirstmateService.pipe(Effect.provide(context));
      // No coordinator yet: only the setting changes.
      yield* service.setAppearance({ name: "Jarvis", icon: "bot" });
      expect(dispatched).toHaveLength(0);
      yield* service.setCoordinator({ threadId: coordinator });
      yield* service.setAppearance({ name: "Jarvis", icon: "bot" });
      expect(dispatched).toEqual([
        expect.objectContaining({
          type: "thread.metadata.update",
          threadId: coordinator,
          title: "Jarvis",
        }),
      ]);
      // An unchanged title or a missing chat sends nothing.
      titles.set(coordinator, "Jarvis");
      yield* service.setAppearance({ name: "Jarvis", icon: "star" });
      yield* service.setCoordinator({ threadId: ThreadId.make("gone") });
      yield* service.setAppearance({ name: "Mate", icon: "star" });
      expect(dispatched).toHaveLength(1);
      // The home project follows every save; it skips an unchanged title itself.
      expect(projectRenames).toEqual(["Jarvis", "Jarvis", "Jarvis", "Mate"]);
    }).pipe(Effect.scoped),
  );

  it.effect("adds the name and icon columns to a config table from before they existed", () =>
    Effect.gen(function* () {
      const sqlite = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          CREATE TABLE firstmate_config (
            config_id INTEGER PRIMARY KEY CHECK (config_id = 1),
            coordinator_thread_id TEXT
          )
        `;
        yield* sql`INSERT INTO firstmate_config(config_id, coordinator_thread_id) VALUES (1, ${coordinator})`;
      }).pipe(Effect.provide(sqlite));
      const layer = FirstmateService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(FirstmateHome.FirstmateHome)({ rename: () => Effect.void }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(null),
            }),
            NodeCrypto.layer,
            Layer.succeedContext(sqlite),
          ),
        ),
      );
      const service = yield* FirstmateService.FirstmateService.pipe(
        Effect.provide(yield* Layer.build(layer)),
      );
      expect(yield* snapshot(service)).toMatchObject({
        coordinatorThreadId: coordinator,
        name: "Firstmate",
        icon: "compass",
      });
      // A second start leaves the columns, and the saved values, alone.
      yield* service.setAppearance({ name: "Jarvis", icon: "anchor" });
      const again = yield* FirstmateService.FirstmateService.pipe(
        Effect.provide(yield* Layer.build(layer)),
      );
      expect(yield* snapshot(again)).toMatchObject({ name: "Jarvis", icon: "anchor" });
    }).pipe(Effect.scoped),
  );
});
