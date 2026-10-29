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
import { withWorkspaceLease } from "./workspaceLease.ts";

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
    readonly withWorkspace: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | TreehouseThreadWorkspaceError, R>;
  }
>()("t3/workspace/TreehouseThreadWorkspaces") {}

const make = Effect.gen(function* () {
  const pool = yield* TreehouseWorktrees.TreehouseWorktrees;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const prepare = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const projection = yield* threads.getThreadProjection(threadId);
      const { worktreePath, branch } = projection.thread;
      if (worktreePath === null || branch === null) return null;
      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) return null;
      const nextPath = yield* pool.ensure({
        threadId,
        rootThreadId: projection.thread.lineage.rootThreadId,
        cwd: project.value.workspaceRoot,
        worktreePath,
        branch,
      });
      if (nextPath !== null && nextPath !== worktreePath) {
        const id = yield* randomUuidV4;
        // The start this wraps resumes the provider thread in nextPath (cwd is
        // part of its load key), so live sessions stay attached: detaching
        // here would unsubscribe the turn that start is about to begin.
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(id),
          threadId,
          worktreePath: nextPath,
          keepProviderSessions: true,
        });
      }
      return nextPath ?? worktreePath;
    }).pipe(Effect.mapError((cause) => new TreehouseThreadWorkspaceError({ threadId, cause })));
  const withWorkspace = Effect.fn("TreehouseThreadWorkspaces.withWorkspace")(function* <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E | TreehouseThreadWorkspaceError, R> {
    if (!pool.enabled) return yield* effect;
    const projection = yield* threads
      .getThreadProjection(threadId)
      .pipe(Effect.mapError((cause) => new TreehouseThreadWorkspaceError({ threadId, cause })));
    const originalPath = projection.thread.worktreePath;
    if (originalPath === null) return yield* effect;
    return yield* withWorkspaceLease(
      originalPath,
      prepare(threadId).pipe(
        Effect.flatMap((nextPath) =>
          nextPath !== null && nextPath !== originalPath
            ? withWorkspaceLease(nextPath, effect)
            : effect,
        ),
      ),
    );
  });
  return TreehouseThreadWorkspaces.of({ withWorkspace });
});
export const layer = Layer.effect(TreehouseThreadWorkspaces, make);
