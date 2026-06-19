import { CircleCheck, CircleDashed, CircleDot, CircleX, GitMerge } from "lucide-react";
import type { ComponentType } from "react";

import { ISSUE_STATUS_LABEL, type IssueStatus } from "../../dashboardIssues";
import { Badge } from "../ui/badge";

type BadgeVariant = "success" | "warning" | "info" | "error" | "secondary";

const STATUS_PRESENTATION: Record<
  IssueStatus,
  { variant: BadgeVariant; Icon: ComponentType<{ className?: string }> }
> = {
  ready: { variant: "success", Icon: CircleDot },
  draft: { variant: "warning", Icon: CircleDashed },
  merged: { variant: "info", Icon: GitMerge },
  closed: { variant: "error", Icon: CircleX },
  "worktree-only": { variant: "secondary", Icon: CircleCheck },
};

export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  const { variant, Icon } = STATUS_PRESENTATION[status];
  return (
    <Badge variant={variant} size="sm">
      <Icon className="size-3" />
      {ISSUE_STATUS_LABEL[status]}
    </Badge>
  );
}
