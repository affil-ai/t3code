// fork: scheduled-task-inherit-model
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const idleProjection = {
  runs: [],
  providerTurns: [],
  providerThreads: [],
  providerSessions: [],
  nodes: [],
};

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const baseInput = {
  title: "Check inbox",
  prompt: "Check the inbox.",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: "project-model",
  workspaceStrategy: { type: "root" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

const withService = <A, E, R>(
  program: (recorded: {
    readonly sends: Ref.Ref<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>;
    readonly launches: Ref.Ref<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sends = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
      [],
    );
    const launches = yield* Ref.make<ReadonlyArray<ThreadLaunchService.ThreadLaunchInput>>([]);
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Ref.update(launches, (values) => [...values, input]).pipe(
            Effect.as({ threadId: ThreadId.make("thread-launched") } as never),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getProjectThreadRecords: () => Effect.succeed(idleProjection as never),
        sendToThread: (input) =>
          Ref.update(sends, (values) => [...values, input]).pipe(
            Effect.as({} as ThreadManagementService.ThreadManagementSendResult),
          ),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
    );
    return yield* program({ sends, launches }).pipe(
      Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

it.effect("saves a chat-bound task without a model and runs it on the chat's model", () =>
  withService(({ sends }) =>
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(
        yield* decodeUpsertInput({ ...baseInput, threadId: "thread-bound" }),
      );
      assert.equal(task.modelSelection, null);
      const listed = yield* service.list();
      assert.equal(listed.tasks[0]?.modelSelection, null);

      yield* service.runNow({ id: task.id });
      const [send] = yield* Ref.get(sends);
      assert.equal(send?.threadId, "thread-bound");
      assert.equal(send?.modelSelection, undefined);
    }),
  ),
);

it.effect("keeps a bound task's stored model on edit and never sends it to the chat", () =>
  withService(({ sends }) =>
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const modelSelection = { instanceId: "codex", model: "gpt-5.4" };
      const input = yield* decodeUpsertInput({
        ...baseInput,
        threadId: "thread-bound",
        modelSelection,
      });
      const { task } = yield* service.upsert(input);
      const { modelSelection: _omitted, ...withoutModel } = input;
      const edited = yield* service.upsert({ ...withoutModel, id: task.id, title: "Renamed" });
      assert.deepEqual(edited.task.modelSelection, modelSelection);

      yield* service.runNow({ id: task.id });
      const [send] = yield* Ref.get(sends);
      assert.equal(send?.modelSelection, undefined);
    }),
  ),
);

it.effect("launches a fresh-thread run with its model and rejects one without", () =>
  withService(({ launches }) =>
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const rejected = yield* service
        .upsert(yield* decodeUpsertInput({ ...baseInput, threadId: null }))
        .pipe(Effect.flip);
      assert.equal(rejected.message, "A task that starts a new thread for each run needs a model.");
      assert.deepEqual((yield* service.list()).tasks, []);

      const modelSelection = { instanceId: "codex", model: "gpt-5.4" };
      const { task } = yield* service.upsert(
        yield* decodeUpsertInput({ ...baseInput, threadId: null, modelSelection }),
      );
      yield* service.runNow({ id: task.id });
      const [launch] = yield* Ref.get(launches);
      assert.deepEqual(launch?.modelSelection, modelSelection);
    }),
  ),
);

it.effect("rejects unbinding a task that has no model", () =>
  withService(() =>
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert(
        yield* decodeUpsertInput({ ...baseInput, threadId: "thread-bound" }),
      );
      const rejected = yield* service
        .upsert(yield* decodeUpsertInput({ ...baseInput, id: task.id, threadId: null }))
        .pipe(Effect.flip);
      assert.equal(rejected.message, "A task that starts a new thread for each run needs a model.");
      assert.equal((yield* service.list()).tasks[0]?.threadId, "thread-bound");
    }),
  ),
);
