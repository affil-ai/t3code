import type { EnvironmentId } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import { LayoutGrid, List, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useTransition } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  buildDashboardIssues,
  dashboardProjectFilterKey,
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
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "../../store";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { DashboardToolbar } from "./DashboardToolbar";
import { IssueBoardCard } from "./IssueBoardCard";
import { IssueRow } from "./IssueRow";
import { STATUS_PRESENTATION } from "./IssueStatusBadge";

function dashboardIssueKey(issue: { id: string }) {
  return issue.id;
}

export function DashboardIssuesView() {
  useDocumentTitle(formatDocumentTitle("Dashboard"));
  const environmentId = usePrimaryEnvironmentId();

  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const allThreads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const config = useDashboardViewStore((state) => state.config);
  const setViewMode = useDashboardViewStore((state) => state.setViewMode);
  const [, startViewTransition] = useTransition();

  const selectedProjectIds = useMemo(
    () => new Set(config.filters.projectIds),
    [config.filters.projectIds],
  );
  const selectedProjects = useMemo(
    () =>
      selectedProjectIds.size === 0
        ? projects
        : projects.filter(
            (project) =>
              selectedProjectIds.has(dashboardProjectFilterKey(project)) ||
              selectedProjectIds.has(project.id),
          ),
    [projects, selectedProjectIds],
  );
  const selectedProjectKeys = useMemo(
    () => new Set(selectedProjects.map(dashboardProjectFilterKey)),
    [selectedProjects],
  );
  const selectedThreads = useMemo(
    () =>
      selectedProjectIds.size === 0
        ? allThreads
        : allThreads.filter((thread) =>
            selectedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
          ),
    [allThreads, selectedProjectIds, selectedProjectKeys],
  );

  const pullRequestTargets = useMemo(() => {
    const cwdsByEnvironment = new Map<string, Set<string>>();
    for (const project of selectedProjects) {
      const existing = cwdsByEnvironment.get(project.environmentId) ?? new Set<string>();
      existing.add(project.cwd);
      cwdsByEnvironment.set(project.environmentId, existing);
    }
    return [...cwdsByEnvironment].map(([targetEnvironmentId, cwds]) => ({
      environmentId: targetEnvironmentId as EnvironmentId,
      cwds: [...cwds],
    }));
  }, [selectedProjects]);
  const { pullRequests, failures, isLoading, error, refresh } = useDashboardPullRequests({
    targets: pullRequestTargets,
  });

  const issues = useMemo(
    () =>
      buildDashboardIssues({ threads: selectedThreads, pullRequests, projects: selectedProjects }),
    [selectedThreads, pullRequests, selectedProjects],
  );

  const visibleIssues = useMemo(() => {
    const filtered = filterIssues(issues, config.filters);
    return sortIssues(filtered, config.sortField, config.sortDirection);
  }, [issues, config.filters, config.sortField, config.sortDirection]);

  const board = useMemo(
    () => (config.viewMode === "board" ? groupIssuesByStatus(visibleIssues) : []),
    [config.viewMode, visibleIssues],
  );

  const renderListIssue = useCallback(
    ({ item }: { item: (typeof visibleIssues)[number] }) => <IssueRow issue={item} />,
    [],
  );

  const renderBoardIssue = useCallback(
    ({ item }: { item: (typeof visibleIssues)[number] }) => (
      <div className="pb-2">
        <IssueBoardCard issue={item} />
      </div>
    ),
    [],
  );

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="flex h-11 shrink-0 items-center justify-between border-border border-b pr-3 pl-12 sm:pr-5">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground text-sm">Dashboard</span>
            <span className="text-muted-foreground/70 text-xs">
              {visibleIssues.length} {visibleIssues.length === 1 ? "issue" : "issues"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ToggleGroup
              variant="outline"
              size="sm"
              value={[config.viewMode]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "list" || next === "board") {
                  startViewTransition(() => setViewMode(next));
                }
              }}
            >
              <Toggle value="list" aria-label="List view">
                <List className="size-3.5" />
              </Toggle>
              <Toggle value="board" aria-label="Board view">
                <LayoutGrid className="size-3.5" />
              </Toggle>
            </ToggleGroup>

            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              onClick={refresh}
              disabled={isLoading}
              aria-label="Refresh pull requests"
            >
              <RefreshCw className={isLoading ? "size-3.5 animate-spin" : "size-3.5"} />
            </Button>
          </div>
        </header>

        <DashboardToolbar projects={projects} />

        {error ? (
          <div className="border-border border-b bg-destructive/8 px-3 py-2 text-destructive-foreground text-xs">
            Failed to load pull requests: {error}
          </div>
        ) : null}
        {failures.length > 0 ? (
          <div className="border-border border-b bg-warning/8 px-3 py-2 text-warning-foreground text-xs">
            <details>
              <summary className="cursor-pointer font-medium">
                {failures.length} {failures.length === 1 ? "repository" : "repositories"} could not
                be queried for pull requests. Worktree-only issues are still shown.
              </summary>
              <ul className="mt-2 space-y-1 text-warning-foreground/85">
                {failures.map((failure) => (
                  <li
                    key={`${failure.environmentId}:${failure.cwd}`}
                    className="grid grid-cols-[minmax(10rem,22rem)_1fr] gap-3"
                  >
                    <span className="truncate font-mono" title={failure.cwd}>
                      {failure.cwd}
                    </span>
                    <span className="min-w-0 break-words">{failure.message}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        ) : null}

        <div
          className={
            config.viewMode === "board"
              ? "min-h-0 flex-1 overflow-hidden"
              : "min-h-0 flex-1 overflow-hidden"
          }
        >
          {environmentId === null && projects.length === 0 && allThreads.length === 0 ? (
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
                      ? "No pull requests or worktrees found yet."
                      : "No issues match the current filters."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : config.viewMode === "list" ? (
            <LegendList
              data={visibleIssues}
              keyExtractor={dashboardIssueKey}
              renderItem={renderListIssue}
              estimatedItemSize={76}
              drawDistance={640}
              recycleItems
              className="h-full overflow-x-hidden overscroll-y-contain"
            />
          ) : (
            <div className="flex h-full min-h-0 gap-3 overflow-x-auto overflow-y-hidden p-3">
              {board.map((column) => {
                const { iconClassName, Icon } = STATUS_PRESENTATION[column.status];
                return (
                  <div
                    key={column.status}
                    className="flex h-full min-h-0 w-72 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card/30"
                  >
                    <div className="z-10 flex items-center justify-between border-border/70 border-b bg-card/95 px-3 py-2 backdrop-blur-sm">
                      <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground text-xs">
                        <Icon className={`size-4 shrink-0 ${iconClassName}`} />
                        <span className="truncate">{ISSUE_STATUS_LABEL[column.status]}</span>
                      </span>
                      <span className="shrink-0 text-muted-foreground/70 text-xs">
                        {column.issues.length}
                      </span>
                    </div>
                    <LegendList
                      data={column.issues}
                      keyExtractor={dashboardIssueKey}
                      renderItem={renderBoardIssue}
                      estimatedItemSize={116}
                      drawDistance={480}
                      recycleItems
                      className="h-full min-h-0 overflow-x-hidden overscroll-y-contain p-2 pb-0"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}
