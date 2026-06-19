import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { ExternalLink, GitPullRequest, MessageSquare } from "lucide-react";

import { WORKTREE_ORIGIN_LABEL, type DashboardIssue } from "../../dashboardIssues";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { CreateWorktreeButton } from "./CreateWorktreeButton";

export function IssueBoardCard({
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

  const title = (
    <span className="line-clamp-2 font-medium text-foreground text-sm">{issue.title}</span>
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-xs/5">
      {threadRef ? (
        <Link
          className="hover:underline"
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(threadRef)}
        >
          {title}
        </Link>
      ) : (
        title
      )}

      {issue.branch ? (
        <span className="max-w-full truncate font-mono text-muted-foreground text-xs">
          {issue.branch}
        </span>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {issue.project ? (
          <Badge variant="outline" size="sm">
            {issue.project.name}
          </Badge>
        ) : null}
        {issue.hasWorktree ? (
          <Badge variant="secondary" size="sm">
            {WORKTREE_ORIGIN_LABEL[issue.worktreeOrigin]}
          </Badge>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {issue.externalLink ? (
            <a
              className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
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
              className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
              href={issue.pullRequest.url}
              target="_blank"
              rel="noreferrer"
              title={`Open PR #${issue.pullRequest.number}`}
            >
              <GitPullRequest className="size-3" />#{issue.pullRequest.number}
              <ExternalLink className="size-2.5" />
            </a>
          ) : null}
        </div>
        <span className="text-muted-foreground text-xs">
          {issue.updatedAt ? formatRelativeTimeLabel(issue.updatedAt) : "—"}
        </span>
      </div>

      {issue.thread === null && issue.pullRequest !== null && issue.project !== null ? (
        <CreateWorktreeButton
          environmentId={environmentId}
          project={issue.project}
          pullRequest={issue.pullRequest}
        />
      ) : null}
    </div>
  );
}
