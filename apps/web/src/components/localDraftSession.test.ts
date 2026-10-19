import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftSessionState } from "../composerDraftStore";
import { applyLocalDraftContextPatch } from "./localDraftSession";

const hostWorktreeDraft: DraftSessionState = {
  threadId: ThreadId.make("thread-new"),
  environmentId: EnvironmentId.make("env-1"),
  projectId: ProjectId.make("project-1"),
  logicalProjectKey: "",
  createdAt: "2026-09-25T12:00:00.000Z",
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/dock",
  worktreePath: "/repo/.worktrees/dock",
  envMode: "worktree",
  startFromOrigin: false,
};

describe("applyLocalDraftContextPatch", () => {
  it("leaves the host worktree for a new one, keeping its branch as the base", () => {
    expect(
      applyLocalDraftContextPatch(hostWorktreeDraft, { envMode: "worktree", worktreePath: null }),
    ).toMatchObject({ envMode: "worktree", worktreePath: null, branch: "feature/dock" });
  });

  it("points at an existing worktree like the Previous worktree hop", () => {
    const local: DraftSessionState = {
      ...hostWorktreeDraft,
      branch: null,
      worktreePath: null,
      envMode: "local",
    };
    expect(
      applyLocalDraftContextPatch(local, { branch: "main", worktreePath: "/repo/.worktrees/main" }),
    ).toMatchObject({ envMode: "worktree", worktreePath: "/repo/.worktrees/main", branch: "main" });
  });

  it("keeps fields a patch does not name, and ignores project changes", () => {
    const next = applyLocalDraftContextPatch(hostWorktreeDraft, {
      interactionMode: "plan",
      projectRef: {
        environmentId: EnvironmentId.make("env-2"),
        projectId: ProjectId.make("project-2"),
      },
    });
    expect(next).toEqual({ ...hostWorktreeDraft, interactionMode: "plan" });
  });
});
