import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  buildDashboardIssues,
  filterIssues,
  groupIssuesByStatus,
  ISSUE_STATUS_LABEL,
  sortIssues,
} from "../../dashboardIssues";
import { useDashboardViewStore } from "../../dashboardViewStore";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { useDashboardPullRequests } from "../../hooks/useDashboardPullRequests";
import { formatDocumentTitle, useDocumentTitle } from "../../lib/documentTitle";
import {
  selectProjectsForEnvironment,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { DashboardToolbar } from "./DashboardToolbar";
import { IssueBoardCard } from "./IssueBoardCard";
import { IssueRow } from "./IssueRow";

export function DashboardIssuesView() {
  useDocumentTitle(formatDocumentTitle("Dashboard"));
  const environmentId = usePrimaryEnvironmentId();

  const projects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, environmentId)),
  );
  const allThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const threads = useMemo(
    () => allThreads.filter((thread) => thread.environmentId === environmentId),
    [allThreads, environmentId],
  );

  const cwds = useMemo(() => projects.map((project) => project.cwd), [projects]);
  const { pullRequests, failures, isLoading, error, refresh } = useDashboardPullRequests({
    environmentId,
    cwds,
  });

  const config = useDashboardViewStore((state) => state.config);

  const issues = useMemo(
    () => buildDashboardIssues({ threads, pullRequests, projects }),
    [threads, pullRequests, projects],
  );

  const visibleIssues = useMemo(() => {
    const filtered = filterIssues(issues, config.filters);
    return sortIssues(filtered, config.sortField, config.sortDirection);
  }, [issues, config.filters, config.sortField, config.sortDirection]);

  const board = useMemo(
    () => (config.viewMode === "board" ? groupIssuesByStatus(visibleIssues) : []),
    [config.viewMode, visibleIssues],
  );

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="flex items-center justify-between border-border border-b py-2 pr-3 pl-12 sm:py-3 sm:pr-5">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground text-sm">Dashboard</span>
            <span className="text-muted-foreground/70 text-xs">
              {visibleIssues.length} {visibleIssues.length === 1 ? "issue" : "issues"}
            </span>
          </div>
        </header>

        <DashboardToolbar onRefresh={refresh} isLoading={isLoading} />

        {error ? (
          <div className="border-border border-b bg-destructive/8 px-3 py-2 text-destructive-foreground text-xs">
            Failed to load pull requests: {error}
          </div>
        ) : null}
        {failures.length > 0 ? (
          <div className="border-border border-b bg-warning/8 px-3 py-2 text-warning-foreground text-xs">
            {failures.length} {failures.length === 1 ? "repository" : "repositories"} could not be
            queried for pull requests (e.g. provider not authenticated). Worktree-only issues are
            still shown.
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto">
          {environmentId === null ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>No environment connected</EmptyTitle>
                <EmptyDescription>
                  Connect an environment to see your pull requests and worktrees here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : visibleIssues.length === 0 ? (
            <Empty className="flex-1">
              <EmptyHeader>
                <EmptyTitle>No issues</EmptyTitle>
                <EmptyDescription>
                  {isLoading
                    ? "Loading pull requests…"
                    : issues.length === 0
                      ? "No pull requests or worktrees found in this environment yet."
                      : "No issues match the current filters."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : config.viewMode === "list" ? (
            <div className="flex flex-col">
              {visibleIssues.map((issue) => (
                <IssueRow key={issue.id} issue={issue} environmentId={environmentId} />
              ))}
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto p-3">
              {board.map((column) => (
                <div
                  key={column.status}
                  className="flex w-72 shrink-0 flex-col gap-2 rounded-xl border border-border bg-card/30 p-2"
                >
                  <div className="flex items-center justify-between px-1 py-1">
                    <span className="font-medium text-foreground text-xs">
                      {ISSUE_STATUS_LABEL[column.status]}
                    </span>
                    <span className="text-muted-foreground/70 text-xs">{column.issues.length}</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {column.issues.map((issue) => (
                      <IssueBoardCard key={issue.id} issue={issue} environmentId={environmentId} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
