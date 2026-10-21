import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AgentProfileId,
  FirstmateError,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  FIRSTMATE_AGENT_ID,
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

const FM = FIRSTMATE_AGENT_ID;

const coordinator = ThreadId.make("firstmate-coordinator");

const layerDependencies = Layer.mergeAll(
  Layer.mock(FirstmateHome.FirstmateHome)({
    migrateLegacyHome: () => Effect.succeed(null),
    migrateAgentsFolder: () => Effect.succeed([]),
    artifactsRoot: "/agents/artifacts",
    rename: () => Effect.void,
    keepImage: ({ taskId, path }) => Effect.succeed(`/kept/${taskId}/${path.split("/").pop()}`),
    keepAvatar: ({ attachmentId }) =>
      attachmentId === "invalid"
        ? Effect.fail(new FirstmateError({ message: "Invalid avatar." }))
        : Effect.succeed(`saved-${attachmentId}`),
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
  return yield* service.subscribe(FM).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
});

describe("FirstmateService", () => {
  it.effect("saves, preserves, replaces, and clears avatars without losing icon and color", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      expect((yield* service.listAgents())[0]?.avatarAttachmentId).toBeUndefined();
      const saved = yield* service.updateAgent({
        agentId: FM,
        icon: "dollar-sign",
        color: "green",
        avatarAttachmentId: "upload-1",
      });
      expect(saved).toMatchObject({
        icon: "dollar-sign",
        color: "green",
        avatarAttachmentId: "saved-upload-1",
      });
      expect(
        (yield* service.updateAgent({ agentId: FM, color: "emerald" })).avatarAttachmentId,
      ).toBe("saved-upload-1");
      expect((yield* service.listAgents())[0]?.avatarAttachmentId).toBe("saved-upload-1");
      expect(
        (yield* service.updateAgent({ agentId: FM, avatarAttachmentId: "upload-2" }))
          .avatarAttachmentId,
      ).toBe("saved-upload-2");
      yield* service.updateAgent({ agentId: FM, avatarAttachmentId: "invalid" }).pipe(Effect.flip);
      expect((yield* service.listAgents())[0]?.avatarAttachmentId).toBe("saved-upload-2");
      const cleared = yield* service.updateAgent({ agentId: FM, avatarAttachmentId: null });
      expect(cleared.avatarAttachmentId).toBeUndefined();
      expect(cleared).toMatchObject({ icon: "dollar-sign", color: "emerald" });
    }).pipe(Effect.provide(layerFirstmate)),
  );
  it.effect("persists reversible task priority without changing lifecycle or order", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create(FM, {
        title: "Priority task",
        intent: "Deliver it",
        definitionOfDone: "Delivered",
      });
      expect(task.priority).toBe(false);
      yield* service.setTaskPriority({ taskId: task.id, priority: true });
      const marked = yield* service.get(FM, { taskId: task.id });
      expect(marked.task).toEqual({ ...task, priority: true });
      expect(marked.events.at(-1)).toMatchObject({ actor: "user", summary: "Marked as priority." });
      yield* service.update(FM, {
        taskId: task.id,
        summary: "Update the note",
        note: "Still working",
      });
      expect((yield* service.get(FM, { taskId: task.id })).task.priority).toBe(true);
      yield* service.setTaskPriority({ taskId: task.id, priority: false });
      expect((yield* service.list(FM)).tasks[0]?.priority).toBe(false);
    }).pipe(Effect.provide(layerFirstmate)),
  );
  it.effect("persists lifecycle separately from attention and supports backlog promotion", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create(FM, {
        title: "Later",
        intent: "Keep this for later",
        definitionOfDone: "Delivered",
        status: "backlog",
        wakeAt: "1970-01-01T00:00:00.000Z",
      });
      expect(task).toMatchObject({ status: "backlog", state: "open", wakeAt: null });
      yield* service.update(FM, {
        taskId: task.id,
        summary: "Needs a decision",
        nextActor: "user",
      });
      expect((yield* service.get(FM, { taskId: task.id })).task.status).toBe("backlog");
      expect((yield* service.list(FM, { status: "backlog" })).tasks).toHaveLength(1);
      yield* service.update(FM, {
        taskId: task.id,
        summary: "Plan it",
        status: "planning",
        nextActor: "coordinator",
      });
      expect((yield* service.list(FM, { status: "backlog" })).tasks).toHaveLength(0);
      const review = yield* service.update(FM, {
        taskId: task.id,
        summary: "Review",
        status: "in_review",
        nextActor: "external",
      });
      expect(review.task).toMatchObject({ status: "in_review", state: "waiting" });
      const attention = yield* service.update(FM, {
        taskId: task.id,
        summary: "Resolve review",
        nextActor: "coordinator",
      });
      expect(attention.task.status).toBe("in_review");
      const ready = yield* service.update(FM, {
        taskId: task.id,
        summary: "Checks passed",
        state: "ready",
        nextActor: "user",
      });
      expect(ready.task.status).toBe("ready_for_deployment");
      expect(
        yield* service
          .update(FM, {
            taskId: task.id,
            summary: "Wrong pair",
            status: "in_progress",
            state: "done",
            closeEvidence: "No",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "FirstmateError" });
      expect(
        yield* service
          .update(FM, {
            taskId: task.id,
            summary: "No evidence",
            status: "done",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "FirstmateError" });
      yield* service.update(FM, {
        taskId: task.id,
        summary: "Shipped",
        status: "done",
        closeEvidence: "Verified release",
      });
      expect((yield* service.list(FM)).tasks).toHaveLength(0);
      expect((yield* service.list(FM, { status: "done" })).tasks).toHaveLength(1);
      const reopened = yield* service.update(FM, {
        taskId: task.id,
        summary: "Follow-up",
        status: "planning",
      });
      expect(reopened.task).toMatchObject({ state: "open", status: "planning", closedAt: null });
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("keeps a live task with open post-release checks active in monitoring", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create(FM, {
        title: "Shipped",
        intent: "Watch the release",
        definitionOfDone: "No new errors for a day",
        status: "ready_for_deployment",
      });
      const live = yield* service.update(FM, {
        taskId: task.id,
        summary: "Merged and deployed",
        status: "monitoring",
        nextActor: "worker",
      });
      expect(live.task).toMatchObject({ status: "monitoring", state: "open", closedAt: null });
      expect((yield* service.list(FM)).tasks.map((t) => t.id)).toEqual([task.id]);
      expect((yield* service.list(FM, { status: "monitoring" })).tasks).toHaveLength(1);
      // A legacy caller writing the same state leaves the status alone.
      yield* service.update(FM, { taskId: task.id, summary: "Still open", state: "open" });
      expect((yield* service.get(FM, { taskId: task.id })).task.status).toBe("monitoring");
      const regressed = yield* service.update(FM, {
        taskId: task.id,
        summary: "Error spike, fixing",
        status: "in_progress",
      });
      expect(regressed.task.status).toBe("in_progress");
      yield* service.update(FM, { taskId: task.id, summary: "Fix live", status: "monitoring" });
      expect(
        yield* service
          .update(FM, { taskId: task.id, summary: "No evidence", status: "done" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "FirstmateError" });
      const done = yield* service.update(FM, {
        taskId: task.id,
        summary: "Checks clean",
        status: "done",
        closeEvidence: "24h error watch clean",
      });
      expect(done.task).toMatchObject({ status: "done", state: "done" });
      const { task: other } = yield* service.create(FM, {
        title: "Backfill",
        intent: "Run the backfill",
        definitionOfDone: "Backfill verified",
        status: "monitoring",
      });
      expect(other).toMatchObject({ status: "monitoring", state: "open" });
      const canceled = yield* service.update(FM, {
        taskId: other.id,
        summary: "Not needed",
        status: "canceled",
        closeEvidence: "Backfill made unnecessary by the fix",
      });
      expect(canceled.task).toMatchObject({ status: "canceled", state: "dropped" });
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("starts unconfigured, sets and clears the coordinator", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      expect((yield* snapshot(service)).coordinatorThreadId).toBeNull();
      expect(
        (yield* service.setCoordinator(FM, { threadId: coordinator })).coordinatorThreadId,
      ).toBe(coordinator);
      expect(
        (yield* service.setCoordinator(FM, { threadId: null })).coordinatorThreadId,
      ).toBeNull();
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("rejects blank create fields and update summaries without appending events", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      expect(
        yield* service
          .create(FM, { title: " ", intent: "Request", definitionOfDone: "Delivered" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "FirstmateError" });
      expect((yield* service.list(FM)).tasks).toHaveLength(0);
      const { task } = yield* service.create(FM, {
        title: "Valid",
        intent: "  Keep my words.  ",
        definitionOfDone: "Delivered",
      });
      expect(task.intent).toBe("  Keep my words.  ");
      expect(
        yield* service
          .update(FM, { taskId: task.id, summary: " ", title: "Changed" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "FirstmateError" });
      const detail = yield* service.get(FM, { taskId: task.id });
      expect(detail.task.title).toBe("Valid");
      expect(detail.events).toHaveLength(1);
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("keeps review artifacts, copying images, and appends or replaces them", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create(FM, {
        title: "Dashboards",
        intent: "Build them",
        definitionOfDone: "Merged",
        artifacts: [{ kind: "link", label: "PR #1", url: "https://example.com/pull/1" }],
      });
      expect(task.artifacts).toEqual([
        { kind: "link", label: "PR #1", url: "https://example.com/pull/1" },
      ]);
      const added = yield* service.update(FM, {
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
      const renamed = yield* service.update(FM, {
        taskId: task.id,
        summary: "Retitled.",
        title: "B",
      });
      expect(renamed.task.artifacts).toHaveLength(2);
      const replaced = yield* service.update(FM, {
        taskId: task.id,
        summary: "New round.",
        artifacts: [{ kind: "link", label: "Preview", url: "https://example.com/preview" }],
      });
      expect(replaced.task.artifacts?.map((artifact) => artifact.label)).toEqual(["Preview"]);
      expect((yield* service.get(FM, { taskId: task.id })).task.artifacts).toHaveLength(1);
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("retains open-only list defaults and logs worker replacement", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create(FM, {
        title: "Task",
        intent: "Request",
        definitionOfDone: "Delivered",
        workerThreadId: ThreadId.make("worker-1"),
      });
      yield* service.update(FM, {
        taskId: task.id,
        workerThreadId: ThreadId.make("worker-2"),
        summary: "Replaced the worker.",
      });
      const detail = yield* service.get(FM, { taskId: task.id });
      expect(detail.task.workerThreadId).toBe("worker-2");
      expect(detail.events.map((event) => event.summary)).toEqual([
        "Task created.",
        "Replaced the worker.",
      ]);
      yield* service.update(FM, {
        taskId: task.id,
        state: "dropped",
        closeEvidence: "User asked to stop.",
        summary: "Dropped with approval.",
      });
      expect((yield* service.list(FM)).tasks).toHaveLength(0);
      expect((yield* service.list(FM, { state: "dropped" })).tasks).toHaveLength(1);
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("creates tasks and appends a typed event", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const result = yield* service.create(FM, {
        title: "Ship the board",
        intent: "Build the Firstmate board exactly as requested.",
        definitionOfDone: "The board is available in the web app.",
        nextActor: "worker",
        note: "Queued",
        workerThreadId: ThreadId.make("worker-1"),
        summary: "Recorded the board task.",
      });
      const detail = yield* service.get(FM, { taskId: result.task.id });
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

  it.effect("stores the next step and records each change in the event log", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const { task } = yield* service.create(FM, {
        title: "Merge #4118",
        intent: "Merge it.",
        definitionOfDone: "Merged.",
        nextActor: "user",
        nextStep: "Approve merge of #4118",
      });
      expect(task.nextStep).toBe("Approve merge of #4118");

      // A task created without one has none.
      const plain = yield* service.create(FM, {
        title: "Plain",
        intent: "Plain.",
        definitionOfDone: "Done.",
      });
      expect(plain.task.nextStep).toBeNull();

      // An update that leaves it alone records no next-step event.
      yield* service.update(FM, { taskId: task.id, summary: "Noted.", note: "n" });
      yield* service.update(FM, {
        taskId: task.id,
        summary: "Worker is on it.",
        nextActor: "worker",
        nextStep: "Worker fixing Office comment",
      });
      yield* service.update(FM, { taskId: task.id, summary: "Cleared.", nextStep: null });
      const detail = yield* service.get(FM, { taskId: task.id });
      expect(detail.task.nextStep).toBeNull();
      expect(detail.events.map((event) => event.summary)).toEqual([
        "Task created.",
        "Next step: Approve merge of #4118",
        "Noted.",
        "Worker is on it.",
        "Next step: Worker fixing Office comment",
        "Cleared.",
        "Next step cleared.",
      ]);

      // The board carries it.
      const board = yield* snapshot(service);
      expect(board.tasks.find((candidate) => candidate.id === task.id)?.nextStep).toBeNull();

      // Longer than 80 characters is refused.
      const tooLong = yield* service
        .update(FM, { taskId: task.id, summary: "Long.", nextStep: "x".repeat(81) })
        .pipe(Effect.flip);
      expect(tooLong._tag).toBe("FirstmateError");
    }).pipe(Effect.provide(layerFirstmate)),
  );

  it.effect("requires close evidence and clears closedAt when reopened", () =>
    Effect.gen(function* () {
      const service = yield* FirstmateService.FirstmateService;
      const created = yield* service.create(FM, {
        title: "Close me",
        intent: "Demonstrate close validation.",
        definitionOfDone: "The close path is tested.",
      });
      const invalid = yield* service
        .update(FM, {
          taskId: created.task.id,
          state: "done",
          summary: "Attempted to close without evidence.",
        })
        .pipe(Effect.flip);
      expect(invalid).toMatchObject({ _tag: "FirstmateError" });

      const closed = yield* service.update(FM, {
        taskId: created.task.id,
        state: "done",
        closeEvidence: "The user accepted the delivered result.",
        summary: "Closed with user acceptance.",
      });
      expect(closed.task.state).toBe("done");
      expect(closed.task.closedAt).not.toBeNull();
      expect(closed.task.closeEvidence).toBe("The user accepted the delivered result.");

      const reopened = yield* service.update(FM, {
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
      const open = yield* service.create(FM, {
        title: "Still open",
        intent: "Remain visible on the board.",
        definitionOfDone: "It is not closed.",
      });
      const closed: FirstmateService.FirstmateTask[] = [];
      for (let index = 0; index < 22; index += 1) {
        const created = yield* service.create(FM, {
          title: `Closed ${index}`,
          intent: `Closed task ${index}.`,
          definitionOfDone: "The task is closed.",
        });
        const result = yield* service.update(FM, {
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
              migrateLegacyHome: () => Effect.succeed(null),
              migrateAgentsFolder: () => Effect.succeed([]),
              artifactsRoot: "/agents/artifacts",
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
      yield* service.setAppearance(FM, { name: "Jarvis", icon: "bot" });
      const result = yield* service.start(FM, { modelSelection });
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
              migrateLegacyHome: () => Effect.succeed(null),
              migrateAgentsFolder: () => Effect.succeed([]),
              artifactsRoot: "/agents/artifacts",
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
        .start(FM, {
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        })
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
      const saved = yield* service.setAppearance(FM, { name: "  Jarvis ", icon: "rocket" });
      expect(saved).toMatchObject({ name: "Jarvis", icon: "rocket" });
      expect(yield* snapshot(service)).toMatchObject({ name: "Jarvis", icon: "rocket" });
      expect(
        yield* service.setAppearance(FM, { name: " ", icon: "rocket" }).pipe(Effect.flip),
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
              migrateLegacyHome: () => Effect.succeed(null),
              migrateAgentsFolder: () => Effect.succeed([]),
              artifactsRoot: "/agents/artifacts",
              rename: ({ name }) => Effect.sync(() => void projectRenames.push(name)),
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
      yield* service.setAppearance(FM, { name: "Jarvis", icon: "bot" });
      expect(dispatched).toHaveLength(0);
      yield* service.setCoordinator(FM, { threadId: coordinator });
      yield* service.setAppearance(FM, { name: "Jarvis", icon: "bot" });
      expect(dispatched).toEqual([
        expect.objectContaining({
          type: "thread.metadata.update",
          threadId: coordinator,
          title: "Jarvis",
        }),
      ]);
      // An unchanged title or a missing chat sends nothing.
      titles.set(coordinator, "Jarvis");
      yield* service.setAppearance(FM, { name: "Jarvis", icon: "star" });
      yield* service.setCoordinator(FM, { threadId: ThreadId.make("gone") });
      yield* service.setAppearance(FM, { name: "Mate", icon: "star" });
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
        // A task table from before agents: no agent_id, no artifacts.
        yield* sql`
          CREATE TABLE firstmate_task (
            task_id TEXT PRIMARY KEY, title TEXT NOT NULL, intent TEXT NOT NULL,
            definition_of_done TEXT NOT NULL, state TEXT NOT NULL, next_actor TEXT NOT NULL,
            note TEXT NOT NULL, wake_at TEXT, worker_thread_id TEXT, links_json TEXT NOT NULL,
            close_evidence TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
            last_reported_run_id TEXT, orphan_notified_at TEXT
          )
        `;
        yield* sql`
          INSERT INTO firstmate_task(task_id, title, intent, definition_of_done, state, next_actor, note, links_json, created_at, updated_at)
          VALUES ('firstmate-task:old', 'Old task', 'Do it', 'Done', 'open', 'coordinator', '', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
        `;
      }).pipe(Effect.provide(sqlite));
      const layer = FirstmateService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(FirstmateHome.FirstmateHome)({
              rename: () => Effect.void,
              migrateLegacyHome: () => Effect.succeed(null),
              migrateAgentsFolder: () => Effect.succeed([]),
              artifactsRoot: "/agents/artifacts",
            }),
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
        agentId: "firstmate",
        coordinatorThreadId: coordinator,
        name: "Firstmate",
        icon: "compass",
        tasks: [{ id: "firstmate-task:old", title: "Old task" }],
      });
      // Firstmate is the first agent, carrying the old settings over.
      expect(yield* service.listAgents()).toMatchObject([
        { id: "firstmate", slug: "firstmate", coordinatorThreadId: coordinator },
      ]);
      const [legacy] = yield* service.listStored();
      expect(legacy!.lastTerminalNoticeRunId).toBeNull();
      yield* service.markTerminalNoticeRun(legacy!.id, "run:failed");
      // A second start leaves the columns, and the saved values, alone.
      yield* service.setAppearance(FM, { name: "Jarvis", icon: "anchor" });
      const again = yield* FirstmateService.FirstmateService.pipe(
        Effect.provide(yield* Layer.build(layer)),
      );
      expect(yield* snapshot(again)).toMatchObject({ name: "Jarvis", icon: "anchor" });
      const [restored] = yield* again.listStored();
      expect(restored!.lastTerminalNoticeRunId).toBe("run:failed");
      expect(restored!.lastReportedRunId).toBeNull();
      const { task: visible } = yield* again.get(FM, { taskId: legacy!.id });
      expect(visible).not.toHaveProperty("lastTerminalNoticeRunId");
      expect(restored!.updatedAt).toBe(legacy!.updatedAt);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps each agent's tasks and settings apart", () =>
    Effect.gen(function* () {
      const sqlite = yield* Layer.build(NodeSqliteClient.layer({ filename: ":memory:" }));
      const service = yield* FirstmateService.FirstmateService.pipe(
        Effect.provide(
          yield* Layer.build(
            FirstmateService.layer.pipe(
              Layer.provide(Layer.mergeAll(layerDependencies, Layer.succeedContext(sqlite))),
            ),
          ),
        ),
      );
      const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(sqlite));
      yield* sql`
        INSERT INTO firstmate_agent(agent_id, slug, name, icon, color, role, created_at)
        VALUES ('agent:growth', 'growth', 'Growth', 'rocket', 'rose', 'Grow things.', '2026-01-01T00:00:00.000Z')
      `;
      const growth = AgentProfileId.make("agent:growth");
      const mine = yield* service.create(FM, {
        title: "Firstmate task",
        intent: "Mine",
        definitionOfDone: "Done",
      });
      const theirs = yield* service.create(growth, {
        title: "Growth task",
        intent: "Theirs",
        definitionOfDone: "Done",
      });
      expect((yield* service.list(FM)).tasks.map((task) => task.id)).toEqual([mine.task.id]);
      expect((yield* service.list(growth)).tasks.map((task) => task.id)).toEqual([theirs.task.id]);
      // Another agent's task is not found, so it cannot be read or changed.
      expect(yield* service.get(FM, { taskId: theirs.task.id }).pipe(Effect.flip)).toMatchObject({
        _tag: "FirstmateError",
      });
      expect(
        yield* service
          .update(FM, { taskId: theirs.task.id, summary: "Steal", title: "Mine now" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "FirstmateError" });
      expect((yield* service.get(growth, { taskId: theirs.task.id })).task.title).toBe(
        "Growth task",
      );
      // Boards carry their own name and coordinator.
      yield* service.setCoordinator(growth, { threadId: ThreadId.make("growth-chat") });
      const board = yield* service
        .subscribe(growth)
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      expect(board).toMatchObject({
        agentId: growth,
        name: "Growth",
        icon: "rocket",
        coordinatorThreadId: "growth-chat",
        tasks: [{ id: theirs.task.id }],
      });
      expect((yield* snapshot(service)).coordinatorThreadId).toBeNull();
      expect(yield* service.agentForThread(ThreadId.make("growth-chat"))).toMatchObject({
        id: growth,
      });
      expect(yield* service.agentForThread(ThreadId.make("nobody"))).toBeNull();
      // Firstmate cannot be archived; other agents can, and leave the list.
      expect(yield* service.archiveAgent({ agentId: FM }).pipe(Effect.flip)).toMatchObject({
        _tag: "FirstmateError",
      });
      yield* service.archiveAgent({ agentId: growth });
      expect((yield* service.listAgents()).map((agent) => agent.id)).toEqual(["firstmate"]);
      expect(yield* service.coordinators()).toEqual([]);
    }),
  );

  it.effect("creates an agent with a unique folder name and starts its chat in its folder", () =>
    Effect.gen(function* () {
      const ensured: Array<{ slug: string; name: string; role: string }> = [];
      const launched: ThreadLaunchService.ThreadLaunchInput[] = [];
      const layer = FirstmateService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(FirstmateHome.FirstmateHome)({
              ensure: (input) => {
                ensured.push(input);
                return Effect.succeed({ projectId: ProjectId.make(`project:${input.slug}`) });
              },
              keepAvatar: ({ attachmentId }) => Effect.succeed(`saved-${attachmentId}`),
              rename: () => Effect.void,
              writeRole: () => Effect.void,
              migrateLegacyHome: () => Effect.succeed(null),
              migrateAgentsFolder: () => Effect.succeed([]),
              artifactsRoot: "/agents/artifacts",
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: (input) => {
                launched.push(input);
                return Effect.succeed({
                  threadId: ThreadId.make(`chat:${launched.length}`),
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
      const service = yield* FirstmateService.FirstmateService.pipe(
        Effect.provide(yield* Layer.build(layer)),
      );
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      const first = yield* service.createAgent({
        name: "Growth Lead!",
        role: "You grow the business.",
        icon: "rocket",
        color: "rose",
        modelSelection,
        avatarAttachmentId: "upload",
      });
      expect(first.agent).toMatchObject({
        slug: "growth-lead",
        name: "Growth Lead!",
        coordinatorThreadId: "chat:1",
        homeProjectId: "project:growth-lead",
        modelSelection,
        avatarAttachmentId: "saved-upload",
      });
      expect(ensured).toEqual([
        { slug: "growth-lead", name: "Growth Lead!", role: "You grow the business." },
      ]);
      expect(launched[0]).toMatchObject({
        projectId: "project:growth-lead",
        title: "Growth Lead!",
        workspaceStrategy: { type: "root" },
      });
      // The same name again gets its own folder.
      const second = yield* service.createAgent({
        name: "Growth Lead",
        role: "Another.",
        icon: "bot",
        color: "sky",
        modelSelection,
      });
      expect(second.agent.slug).toBe("growth-lead-2");
      expect((yield* service.listAgents()).map((agent) => agent.slug)).toEqual([
        "firstmate",
        "growth-lead",
        "growth-lead-2",
      ]);
      expect(FirstmateService.slugFor("  Émile & Co  ")).toBe("emile-co");
    }),
  );
});
