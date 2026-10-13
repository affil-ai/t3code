import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import { defaultCoordinatorPrompt } from "./coordinatorPrompt.ts";
import * as FirstmateService from "./FirstmateService.ts";

const coordinator = ThreadId.make("firstmate-coordinator");

const layerDependencies = Layer.mergeAll(
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
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

  it.effect("start launches a fresh coordinator in the Scratch project", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:scratch");
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      const launched: ThreadLaunchService.ThreadLaunchInput[] = [];
      const layer = FirstmateService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "",
              ensureScratchProject: Effect.succeed({ projectId }),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: (input) => {
                launched.push(input);
                return Effect.succeed({
                  threadId: ThreadId.make("launched-coordinator"),
                } as ThreadLaunchService.ThreadLaunchResult);
              },
            }),
            NodeCrypto.layer,
            NodeSqliteClient.layer({ filename: ":memory:" }),
          ),
        ),
      );
      const context = yield* Layer.build(layer);
      const service = yield* FirstmateService.FirstmateService.pipe(Effect.provide(context));
      const result = yield* service.start({ modelSelection });
      expect(result.threadId).toBe("launched-coordinator");
      expect(result.snapshot.coordinatorThreadId).toBe("launched-coordinator");
      expect(launched).toHaveLength(1);
      // A root launch in Scratch: ThreadLaunchService claims the thread's own folder.
      expect(launched[0]).toMatchObject({
        projectId,
        modelSelection,
        workspaceStrategy: { type: "root" },
        initialMessage: { text: defaultCoordinatorPrompt, attachments: [] },
      });
      // A fresh thread: no threadId requested and no reuse.
      expect(launched[0]!.threadId).toBeUndefined();
      expect(launched[0]!.reuseExistingThread).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("start fails without launching when Scratch is unavailable", () =>
    Effect.gen(function* () {
      const launched: ThreadLaunchService.ThreadLaunchInput[] = [];
      const layer = FirstmateService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "",
              ensureScratchProject: Effect.fail(
                new ManagedProjectFolders.ScratchUnavailableError(),
              ),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: (input) => {
                launched.push(input);
                return Effect.die("unexpected launch");
              },
            }),
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
      expect(failure.message).toBe(
        "Threads without a project are not available on this environment.",
      );
      expect(launched).toHaveLength(0);
      expect((yield* snapshot(service)).coordinatorThreadId).toBeNull();
    }).pipe(Effect.scoped),
  );
});
