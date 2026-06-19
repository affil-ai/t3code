import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { ExternalLink, FolderGit2, GitPullRequest, MessageSquare } from "lucide-react";

import { WORKTREE_ORIGIN_LABEL, type DashboardIssue } from "../../dashboardIssues";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { CreateWorktreeButton } from "./CreateWorktreeButton";
import { IssueStatusBadge } from "./IssueStatusBadge";

function MetaItem({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">{children}</span>
  );
}

export function IssueRow({
  issue,
  environmentId,
}: {
  issue: DashboardIssue;
  environmentId: EnvironmentId;
}) {
  const threadRef =
    issue.thread !== null
      ? { environmentId: issue.thread.environmentId, threadId: issue.thread.id }
      : null;

  const titleNode = (
    <span className="truncate font-medium text-foreground text-sm">{issue.title}</span>
  );

  return (
    <div className="flex items-center gap-3 border-border border-b px-3 py-2.5 last:border-b-0 hover:bg-accent/40">
      <div className="w-24 shrink-0">
        <IssueStatusBadge status={issue.status} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {threadRef ? (
          <Link
            className="truncate hover:underline"
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams(threadRef)}
          >
            {titleNode}
          </Link>
        ) : (
          titleNode
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {issue.branch ? (
            <MetaItem>
              <FolderGit2 className="size-3" />
              <span className="max-w-56 truncate font-mono">{issue.branch}</span>
            </MetaItem>
          ) : null}
          {issue.project ? <MetaItem>{issue.project.name}</MetaItem> : null}
          {issue.hasWorktree ? (
            <MetaItem>
              <Badge variant="outline" size="sm">
                {WORKTREE_ORIGIN_LABEL[issue.worktreeOrigin]}
              </Badge>
            </MetaItem>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {issue.externalLink ? (
          <a
            className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground hover:underline"
            href={issue.externalLink}
            target="_blank"
            rel="noreferrer"
            title="Open Slack thread"
          >
            <MessageSquare className="size-3" />
            Slack
          </a>
        ) : null}

        {issue.pullRequest ? (
          <a
            className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground hover:underline"
            href={issue.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            title={`Open PR #${issue.pullRequest.number}`}
          >
            <GitPullRequest className="size-3" />#{issue.pullRequest.number}
            <ExternalLink className="size-2.5" />
          </a>
        ) : null}

        <span className="w-20 shrink-0 text-right text-muted-foreground text-xs">
          {issue.updatedAt ? formatRelativeTimeLabel(issue.updatedAt) : "—"}
        </span>

        {issue.thread === null && issue.pullRequest !== null && issue.project !== null ? (
          <CreateWorktreeButton
            environmentId={environmentId}
            project={issue.project}
            pullRequest={issue.pullRequest}
          />
        ) : null}
      </div>
    </div>
  );
}
