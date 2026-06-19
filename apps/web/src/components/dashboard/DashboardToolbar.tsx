import {
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  LayoutGrid,
  List,
  RefreshCw,
  Star,
} from "lucide-react";
import { useState } from "react";

import {
  ISSUE_STATUS_LABEL,
  ISSUE_STATUS_ORDER,
  type DashboardFilters,
  type IssueStatus,
  type SortDirection,
  type SortField,
} from "../../dashboardIssues";
import {
  useDashboardViewStore,
  type DashboardViewMode,
  type SavedDashboardView,
} from "../../dashboardViewStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

function StatusFilterChips({
  selected,
  onToggle,
}: {
  selected: ReadonlyArray<IssueStatus>;
  onToggle: (status: IssueStatus) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {ISSUE_STATUS_ORDER.map((status) => {
        const active = selected.includes(status);
        return (
          <Badge
            key={status}
            render={<button type="button" onClick={() => onToggle(status)} />}
            variant={active ? "default" : "outline"}
            size="default"
          >
            {ISSUE_STATUS_LABEL[status]}
          </Badge>
        );
      })}
    </div>
  );
}

function SavedViewsControl() {
  const savedViews = useDashboardViewStore((state) => state.savedViews);
  const activeViewId = useDashboardViewStore((state) => state.activeViewId);
  const defaultViewId = useDashboardViewStore((state) => state.defaultViewId);
  const applyView = useDashboardViewStore((state) => state.applyView);
  const saveView = useDashboardViewStore((state) => state.saveView);
  const deleteView = useDashboardViewStore((state) => state.deleteView);
  const setDefaultView = useDashboardViewStore((state) => state.setDefaultView);

  const [isNaming, setIsNaming] = useState(false);
  const [draftName, setDraftName] = useState("");

  const commitSave = () => {
    saveView(draftName);
    setDraftName("");
    setIsNaming(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {savedViews.length > 0 ? (
        <Select
          value={activeViewId ?? ""}
          onValueChange={(value) => {
            if (value) {
              applyView(value as string);
            }
          }}
          items={savedViews.map((view: SavedDashboardView) => ({
            value: view.id,
            label: view.name,
          }))}
        >
          <SelectTrigger size="sm" aria-label="Saved views">
            <SelectValue placeholder="Saved views" />
          </SelectTrigger>
          <SelectPopup>
            {savedViews.map((view) => (
              <SelectItem key={view.id} value={view.id}>
                <span className="inline-flex items-center gap-1.5">
                  {view.id === defaultViewId ? (
                    <Star className="size-3 fill-warning text-warning" />
                  ) : null}
                  {view.name}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}

      {isNaming ? (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            className="h-7 w-36 rounded-md border border-input bg-background px-2 text-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="View name"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitSave();
              } else if (event.key === "Escape") {
                setIsNaming(false);
                setDraftName("");
              }
            }}
          />
          <Button type="button" size="xs" variant="default" onClick={commitSave}>
            Save
          </Button>
        </span>
      ) : (
        <Button type="button" size="xs" variant="outline" onClick={() => setIsNaming(true)}>
          Save view
        </Button>
      )}

      {activeViewId ? (
        <>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setDefaultView(defaultViewId === activeViewId ? null : activeViewId)}
          >
            <Star
              className={
                defaultViewId === activeViewId ? "size-3.5 fill-warning text-warning" : "size-3.5"
              }
            />
            {defaultViewId === activeViewId ? "Default" : "Set default"}
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={() => deleteView(activeViewId)}>
            Delete
          </Button>
        </>
      ) : null}
    </div>
  );
}

export function DashboardToolbar({
  onRefresh,
  isLoading,
}: {
  onRefresh: () => void;
  isLoading: boolean;
}) {
  const config = useDashboardViewStore((state) => state.config);
  const setFilters = useDashboardViewStore((state) => state.setFilters);
  const setSort = useDashboardViewStore((state) => state.setSort);
  const setViewMode = useDashboardViewStore((state) => state.setViewMode);

  const updateFilters = (partial: Partial<DashboardFilters>) => {
    setFilters({ ...config.filters, ...partial });
  };

  const toggleStatus = (status: IssueStatus) => {
    const next = config.filters.statuses.includes(status)
      ? config.filters.statuses.filter((candidate) => candidate !== status)
      : [...config.filters.statuses, status];
    updateFilters({ statuses: next });
  };

  return (
    <div className="flex flex-col gap-3 border-border border-b px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusFilterChips selected={config.filters.statuses} onToggle={toggleStatus} />

        <div className="flex items-center gap-2">
          <ToggleGroup
            variant="outline"
            size="sm"
            value={[config.viewMode]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "list" || next === "board") {
                setViewMode(next satisfies DashboardViewMode);
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
            onClick={onRefresh}
            disabled={isLoading}
            aria-label="Refresh pull requests"
          >
            <RefreshCw className={isLoading ? "size-3.5 animate-spin" : "size-3.5"} />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Toggle
            size="sm"
            variant="outline"
            pressed={config.filters.hasWorktree}
            onPressedChange={(pressed) => updateFilters({ hasWorktree: pressed })}
            aria-label="Has worktree"
          >
            Has worktree
          </Toggle>
          <Toggle
            size="sm"
            variant="outline"
            pressed={config.filters.hasSlack}
            onPressedChange={(pressed) => updateFilters({ hasSlack: pressed })}
            aria-label="Has Slack"
          >
            Has Slack
          </Toggle>

          <Select
            value={config.sortField}
            onValueChange={(value) => setSort(value as SortField, config.sortDirection)}
            items={[
              { value: "updated", label: "Updated" },
              { value: "created", label: "Created" },
            ]}
          >
            <SelectTrigger size="sm" aria-label="Sort field">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="updated">Updated</SelectItem>
              <SelectItem value="created">Created</SelectItem>
            </SelectPopup>
          </Select>

          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={() =>
              setSort(
                config.sortField,
                config.sortDirection === "desc" ? "asc" : ("desc" as SortDirection),
              )
            }
            aria-label="Toggle sort direction"
          >
            {config.sortDirection === "desc" ? (
              <ArrowDownWideNarrow className="size-3.5" />
            ) : (
              <ArrowUpWideNarrow className="size-3.5" />
            )}
          </Button>
        </div>

        <SavedViewsControl />
      </div>
    </div>
  );
}
