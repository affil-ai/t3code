import { CircleCheck, CircleDashed, CircleDot, CircleX, GitMerge } from "lucide-react";
import type { ComponentType } from "react";
import type { GitListedPullRequest } from "@t3tools/contracts";

import { ISSUE_STATUS_LABEL, type IssueStatus } from "../../dashboardIssues";
import { Badge } from "../ui/badge";

type BadgeVariant = "success" | "warning" | "info" | "error" | "secondary";

export const STATUS_PRESENTATION: Record<
  IssueStatus,
  { variant: BadgeVariant; iconClassName: string; Icon: ComponentType<{ className?: string }> }
> = {
  ready: { variant: "success", iconClassName: "text-success", Icon: CircleDot },
  draft: { variant: "warning", iconClassName: "text-warning", Icon: CircleDashed },
  merged: { variant: "info", iconClassName: "text-info", Icon: GitMerge },
  closed: { variant: "error", iconClassName: "text-destructive", Icon: CircleX },
  "worktree-only": {
    variant: "secondary",
    iconClassName: "text-muted-foreground",
    Icon: CircleCheck,
  },
};

export function IssueStatusBadge({
  status,
  pullRequest,
}: {
  status: IssueStatus;
  pullRequest?: Pick<GitListedPullRequest, "number" | "url"> | null;
}) {
  const { variant, iconClassName, Icon } = STATUS_PRESENTATION[status];
  const content = (
    <>
      <Icon className={`size-3 ${iconClassName}`} />
      {ISSUE_STATUS_LABEL[status]}
    </>
  );

  if (pullRequest) {
    return (
      <Badge
        variant={variant}
        size="sm"
        render={
          <a
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer"
            title={`Open PR #${pullRequest.number}`}
          />
        }
      >
        {content}
      </Badge>
    );
  }

  return (
    <Badge variant={variant} size="sm">
      {content}
    </Badge>
  );
}
