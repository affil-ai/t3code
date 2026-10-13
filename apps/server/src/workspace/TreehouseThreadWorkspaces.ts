import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as TreehouseWorktrees from "./TreehouseWorktrees.ts";

export class TreehouseThreadWorkspaceError extends Schema.TaggedError<TreehouseThreadWorkspaceError>()(
  "TreehouseThreadWorkspaceError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message() {
    return "Could not restore this chat's worktree lease.";
  }
}

export class TreehouseThreadWorkspaces extends Context.Service<
  TreehouseThreadWorkspaces,
  {
    readonly ensure: (threadId: ThreadId) => Effect.Effect<void, TreehouseThreadWorkspaceError>;
  }
>()("t3/workspace/TreehouseThreadWorkspaces") {}

const make = Effect.gen(function* () {
  const pool = yield* TreehouseWorktrees.TreehouseWorktrees;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  return TreehouseThreadWorkspaces.of({
    ensure: (threadId) =>
      Effect.gen(function* () {
        if (!pool.enabled) return;
        const projection = yield* threads.getThreadProjection(threadId);
        const { worktreePath, branch } = projection.thread;
        if (worktreePath === null || branch === null) return;
        const project = yield* projects.get(projection.thread.projectId);
        if (Option.isNone(project)) return;
        const nextPath = yield* pool.ensure({
          threadId,
          rootThreadId: projection.thread.lineage.rootThreadId,
          cwd: project.value.workspaceRoot,
          worktreePath,
          branch,
        });
        if (nextPath !== null && nextPath !== worktreePath) {
          const id = yield* randomUuidV4;
          yield* threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(id),
            threadId,
            worktreePath: nextPath,
          });
        }
      }).pipe(Effect.mapError((cause) => new TreehouseThreadWorkspaceError({ threadId, cause }))),
  });
});
export const layer = Layer.effect(TreehouseThreadWorkspaces, make);
