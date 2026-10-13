import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as FirstmateService from "../../../firstmate/FirstmateService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { FirstmateToolkit } from "./tools.ts";

const coordinatorRequired =
  "Only the configured Firstmate coordinator thread may create or update tasks.";

const make = Effect.gen(function* () {
  const firstmate = yield* FirstmateService.FirstmateService;

  const requireCoordinator = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = scope.thread;
    if (thread === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: coordinatorRequired,
      });
    }
    const coordinator = yield* firstmate.coordinatorThreadId();
    if (coordinator !== thread.threadId) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: coordinatorRequired,
      });
    }
    return thread;
  });

  return {
    firstmate_task_list: McpToolAccess.reads((input) => firstmate.list(input)),
    firstmate_task_get: McpToolAccess.reads((input) => firstmate.get(input)),
    firstmate_task_create: McpToolAccess.writes((input) =>
      requireCoordinator.pipe(Effect.andThen(firstmate.create(input))),
    ),
    firstmate_task_update: McpToolAccess.writes((input) =>
      requireCoordinator.pipe(Effect.andThen(firstmate.update(input))),
    ),
  } satisfies McpToolAccess.Handlers<typeof FirstmateToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(FirstmateToolkit, make);
