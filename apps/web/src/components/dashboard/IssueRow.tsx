import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { memo } from "react";

import { WORKTREE_ORIGIN_LABEL, type DashboardIssue } from "../../dashboardIssues";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { DashboardIssueActionsMenu } from "./DashboardIssueActionsMenu";
import { DashboardProjectBadge } from "./DashboardProjectBadge";
import { DevinLogoIcon } from "./DevinLogoIcon";
import { IssueStatusBadge } from "./IssueStatusBadge";
import { SlackLogoIcon } from "./SlackLogoIcon";

function MetaItem({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">{children}</span>
  );
}

export const IssueRow = memo(function IssueRow({ issue }: { issue: DashboardIssue }) {
  const threadRef =
    issue.thread !== null
      ? { environmentId: issue.thread.environmentId, threadId: issue.thread.id }
      : null;

  const titleNode = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {issue.hasSlack ? (
        <SlackLogoIcon aria-label="Linked Slack thread" className="size-3.5 shrink-0" />
      ) : null}
      {issue.hasDevin ? (
        <DevinLogoIcon aria-label="Devin branch" className="size-3.5 shrink-0" />
      ) : null}
      <span className="truncate font-medium text-foreground text-sm">{issue.title}</span>
    </span>
  );

  return (
    <div className="flex items-center gap-3 border-border border-b px-3 py-2.5 last:border-b-0 hover:bg-accent/40">
      <div className="w-24 shrink-0">
        <IssueStatusBadge status={issue.status} pullRequest={issue.pullRequest} />
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
          {issue.project ? (
            <MetaItem>
              <DashboardProjectBadge project={issue.project} />
            </MetaItem>
          ) : null}
          {issue.branch ? (
            <MetaItem>
              <span className="max-w-56 truncate font-mono">{issue.branch}</span>
            </MetaItem>
          ) : null}
          {issue.hasWorktree && issue.worktreeOrigin !== "slack" ? (
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

        <span className="w-20 shrink-0 text-right text-muted-foreground text-xs">
          {issue.updatedAt ? formatRelativeTimeLabel(issue.updatedAt) : "—"}
        </span>

        <div className="flex w-7 shrink-0 justify-end">
          <DashboardIssueActionsMenu issue={issue} />
        </div>
      </div>
    </div>
  );
});
