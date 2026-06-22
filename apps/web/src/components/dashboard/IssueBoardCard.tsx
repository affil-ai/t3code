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
import { SlackLogoIcon } from "./SlackLogoIcon";

export const IssueBoardCard = memo(function IssueBoardCard({ issue }: { issue: DashboardIssue }) {
  const threadRef =
    issue.thread !== null
      ? { environmentId: issue.thread.environmentId, threadId: issue.thread.id }
      : null;

  const title = (
    <span className="flex min-w-0 items-start gap-1.5">
      {issue.hasSlack ? (
        <SlackLogoIcon aria-label="Linked Slack thread" className="mt-0.5 size-3.5 shrink-0" />
      ) : null}
      {issue.hasDevin ? (
        <DevinLogoIcon aria-label="Devin branch" className="mt-0.5 size-3.5 shrink-0" />
      ) : null}
      <span className="line-clamp-2 font-medium text-foreground text-sm">{issue.title}</span>
    </span>
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 shadow-xs/5 [contain-intrinsic-size:96px] [content-visibility:auto]">
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

      <div className="flex flex-wrap items-center gap-1.5">
        {issue.project ? <DashboardProjectBadge project={issue.project} /> : null}
        {issue.branch ? (
          <span className="min-w-0 max-w-full truncate font-mono text-muted-foreground text-xs">
            {issue.branch}
          </span>
        ) : null}
        {issue.hasWorktree && issue.worktreeOrigin !== "slack" ? (
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
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">
            {issue.updatedAt ? formatRelativeTimeLabel(issue.updatedAt) : "—"}
          </span>
          <DashboardIssueActionsMenu issue={issue} />
        </div>
      </div>
    </div>
  );
});
