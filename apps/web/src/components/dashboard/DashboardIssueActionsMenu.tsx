import { scopeProjectRef } from "@t3tools/client-runtime";
import {
  EllipsisVertical,
  ExternalLink,
  GitBranchPlusIcon,
  GitPullRequest,
  MessageSquarePlus,
} from "lucide-react";
import { useCallback } from "react";

import type { DashboardIssue } from "../../dashboardIssues";
import { useCreateThreadDraft } from "../../hooks/useHandleNewThread";
import { usePreparePullRequestThreadAction } from "../../lib/sourceControlActions";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

function openExternalUrl(url: string) {
  if (typeof window === "undefined") {
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function DashboardIssueActionsMenu({ issue }: { issue: DashboardIssue }) {
  if (issue.project) {
    return <ProjectDashboardIssueActionsMenu issue={issue} project={issue.project} />;
  }

  return <BaseDashboardIssueActionsMenu issue={issue} />;
}

function BaseDashboardIssueActionsMenu({ issue }: { issue: DashboardIssue }) {
  const hasPullRequest = issue.pullRequest !== null;

  return (
    <Menu>
      <MenuTrigger render={<Button aria-label="Issue actions" size="icon-xs" variant="outline" />}>
        <EllipsisVertical className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52">
        {hasPullRequest ? (
          <MenuItem onClick={() => openExternalUrl(issue.pullRequest!.url)}>
            <GitPullRequest className="size-4" />
            View PR #{issue.pullRequest!.number}
            <ExternalLink className="ml-auto size-3" />
          </MenuItem>
        ) : (
          <MenuItem disabled>No actions available</MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}

function ProjectDashboardIssueActionsMenu({
  issue,
  project,
}: {
  issue: DashboardIssue;
  project: Project;
}) {
  const preparePullRequestThread = usePreparePullRequestThreadAction({
    environmentId: project.environmentId,
    cwd: project.cwd,
  });
  const createThreadDraft = useCreateThreadDraft();

  const canCreateWorktree = issue.thread === null && issue.pullRequest !== null;
  const canCreateThreadInWorktree = issue.worktreePath !== null;
  const hasPullRequest = issue.pullRequest !== null;
  const hasActions = canCreateWorktree || canCreateThreadInWorktree || hasPullRequest;

  const handleCreateWorktree = useCallback(() => {
    const pullRequest = issue.pullRequest;
    if (!pullRequest) {
      return;
    }
    void (async () => {
      try {
        const result = await preparePullRequestThread.run({
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
        toastManager.add({
          type: "error",
          title: "Could not create worktree",
          description: formatError(cause),
        });
      }
    })();
  }, [
    createThreadDraft,
    issue.pullRequest,
    preparePullRequestThread,
    project.environmentId,
    project.id,
  ]);

  const handleCreateThreadInWorktree = useCallback(() => {
    if (!issue.worktreePath) {
      return;
    }
    void createThreadDraft(
      scopeProjectRef(project.environmentId, project.id),
      {
        branch: issue.branch,
        worktreePath: issue.worktreePath,
        envMode: "worktree",
      },
      { navigate: true },
    ).catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not create thread",
        description: formatError(cause),
      });
    });
  }, [createThreadDraft, issue.branch, issue.worktreePath, project.environmentId, project.id]);

  return (
    <Menu>
      <MenuTrigger render={<Button aria-label="Issue actions" size="icon-xs" variant="outline" />}>
        <EllipsisVertical className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-56">
        {canCreateWorktree ? (
          <MenuItem onClick={handleCreateWorktree} disabled={preparePullRequestThread.isPending}>
            <GitBranchPlusIcon className="size-4" />
            {preparePullRequestThread.isPending ? "Creating worktree..." : "Create worktree"}
          </MenuItem>
        ) : null}

        {hasPullRequest ? (
          <MenuItem onClick={() => openExternalUrl(issue.pullRequest!.url)}>
            <GitPullRequest className="size-4" />
            View PR #{issue.pullRequest!.number}
            <ExternalLink className="ml-auto size-3" />
          </MenuItem>
        ) : null}

        {canCreateThreadInWorktree ? (
          <MenuItem onClick={handleCreateThreadInWorktree}>
            <MessageSquarePlus className="size-4" />
            New thread in worktree
          </MenuItem>
        ) : null}

        {!hasActions ? <MenuItem disabled>No actions available</MenuItem> : null}
      </MenuPopup>
    </Menu>
  );
}
