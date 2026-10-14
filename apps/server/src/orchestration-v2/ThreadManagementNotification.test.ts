// fork: firstmate
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:thread-notification");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: a started run stays unstarted, which is all this test reads.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-notification" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const notification = {
  source: { kind: "monitor" as const },
  outcome: "failed" as const,
  summary: "Firstmate: 1 update — Task (worker failed)",
};

// A notification's turn item is a notification row, not a user message. The send
// used to fail after the run was created, so a caller that retries on failure
// (the Firstmate reactor) sent the same wake again every second.
it.effect("reports a notification that starts a turn as started", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const threadId = ThreadId.make("thread:notification-start");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId,
      title: "Coordinator",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const send = (id: string) =>
      threads.sendToThread({
        projectId,
        commandId: CommandId.make(`wake:${id}`),
        threadId,
        messageId: MessageId.make(`firstmate:wake-message:${id}`),
        text: "Firstmate wake-up:",
        notification,
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "server",
      });

    const started = yield* send("idle");
    assert.equal(started.delivery, "started");
    assert.isNull(started.turnItem);
    assert.deepEqual(started.message.notification, notification);

    // Behind the unstarted turn the next wake queues, as before.
    const queued = yield* send("busy");
    assert.equal(queued.delivery, "queued");
    assert.equal(queued.run.status, "queued");
  }).pipe(Effect.provide(layerTest)),
);
