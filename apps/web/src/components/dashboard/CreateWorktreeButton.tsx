import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, GitListedPullRequest } from "@t3tools/contracts";
import { GitBranchPlusIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { useCreateThreadDraft } from "../../hooks/useHandleNewThread";
import { usePreparePullRequestThreadAction } from "../../lib/sourceControlActions";
import type { Project } from "../../types";
import { Button } from "../ui/button";

interface CreateWorktreeButtonProps {
  environmentId: EnvironmentId;
  project: Project;
  pullRequest: GitListedPullRequest;
}

/**
 * Spins up a worktree/thread from a PR's branch, reusing the existing
 * `preparePullRequestThread` action, then navigates to the new draft thread.
 */
export function CreateWorktreeButton({
  environmentId,
  project,
  pullRequest,
}: CreateWorktreeButtonProps) {
  const action = usePreparePullRequestThreadAction({ environmentId, cwd: project.cwd });
  const createThreadDraft = useCreateThreadDraft();
  const [localError, setLocalError] = useState<string | null>(null);

  const handleClick = useCallback(() => {
    setLocalError(null);
    void (async () => {
      try {
        const result = await action.run({
          reference: String(pullRequest.number),
          mode: "worktree",
        });
        await createThreadDraft(
          scopeProjectRef(project.environmentId, project.id),
          {
            branch: result.branch,
            worktreePath: result.worktreePath,
            envMode: result.worktreePath ? "worktree" : "local",
          },
          { navigate: true },
        );
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [action, createThreadDraft, project.environmentId, project.id, pullRequest.number]);

  const error = localError ?? (action.error instanceof Error ? action.error.message : null);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={handleClick}
        disabled={action.isPending}
      >
        <GitBranchPlusIcon className="size-3.5" />
        {action.isPending ? "Creating…" : "Create worktree"}
      </Button>
      {error ? (
        <span className="max-w-48 truncate text-destructive-foreground text-xs" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
