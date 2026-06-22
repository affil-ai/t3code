import { CheckSquare, ChevronDown, GitBranchPlus, Search } from "lucide-react";
import { useState } from "react";

import {
  ISSUE_STATUS_LABEL,
  ISSUE_STATUS_ORDER,
  dashboardProjectFilterKey,
  type DashboardFilters,
  type IssueStatus,
  type SortField,
} from "../../dashboardIssues";
import { useDashboardViewStore } from "../../dashboardViewStore";
import type { Project } from "../../types";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { DashboardProjectIcon } from "./DashboardProjectBadge";
import { DevinLogoIcon } from "./DevinLogoIcon";
import { STATUS_PRESENTATION } from "./IssueStatusBadge";
import { SlackLogoIcon } from "./SlackLogoIcon";

function ProjectFilterMenu({
  projects,
  selectedProjectIds,
  onChange,
}: {
  projects: ReadonlyArray<Project>;
  selectedProjectIds: ReadonlyArray<string>;
  onChange: (projectIds: ReadonlyArray<string>) => void;
}) {
  const selected = new Set(selectedProjectIds);
  const selectedCount = selected.size;
  const isProjectSelected = (project: Project) =>
    selected.has(dashboardProjectFilterKey(project)) || selected.has(project.id);
  const selectedProject = selectedCount === 1 ? (projects.find(isProjectSelected) ?? null) : null;
  const label =
    selectedCount === 0
      ? "All projects"
      : selectedCount === 1
        ? (selectedProject?.name ?? "1 project")
        : `${selectedCount} projects`;

  const setProjectChecked = (projectKey: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) {
      next.add(projectKey);
    } else {
      next.delete(projectKey);
    }
    onChange([...next]);
  };

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button type="button" size="sm" variant="outline">
            {selectedProject ? (
              <DashboardProjectIcon project={selectedProject} />
            ) : (
              <CheckSquare className="size-3.5" />
            )}
            <span className="max-w-32 truncate">{label}</span>
            <ChevronDown className="size-3.5" />
          </Button>
        }
      />
      <MenuPopup align="start" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>Projects</MenuGroupLabel>
          <MenuCheckboxItem checked={selectedCount === 0} onCheckedChange={() => onChange([])}>
            All projects
          </MenuCheckboxItem>
          <MenuSeparator />
          {projects.map((project) => {
            const projectKey = dashboardProjectFilterKey(project);
            return (
              <MenuCheckboxItem
                key={projectKey}
                checked={isProjectSelected(project)}
                onCheckedChange={(checked) => setProjectChecked(projectKey, checked === true)}
              >
                <span className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5">
                    <DashboardProjectIcon project={project} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{project.name}</span>
                    <span className="truncate text-muted-foreground text-xs">{project.cwd}</span>
                  </span>
                </span>
              </MenuCheckboxItem>
            );
          })}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function DashboardStatusFilterIcon({ status }: { status: IssueStatus }) {
  const { Icon, iconClassName } = STATUS_PRESENTATION[status];
  return <Icon className={`size-3.5 ${iconClassName}`} />;
}

function DashboardStatusFilterCombobox({
  selected,
  onChange,
}: {
  selected: ReadonlyArray<IssueStatus>;
  onChange: (statuses: ReadonlyArray<IssueStatus>) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredStatuses =
    normalizedQuery.length === 0
      ? ISSUE_STATUS_ORDER
      : ISSUE_STATUS_ORDER.filter((status) => {
          const label = ISSUE_STATUS_LABEL[status].toLowerCase();
          return label.includes(normalizedQuery) || status.includes(normalizedQuery);
        });
  const label =
    selected.length === 0
      ? "All statuses"
      : selected.length === 1
        ? ISSUE_STATUS_LABEL[selected[0] ?? "ready"]
        : `${selected.length} statuses`;

  return (
    <Combobox<IssueStatus, true>
      multiple
      items={[...ISSUE_STATUS_ORDER]}
      filteredItems={[...filteredStatuses]}
      value={[...selected]}
      onValueChange={onChange}
      itemToStringLabel={(status) => ISSUE_STATUS_LABEL[status]}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
        }
      }}
    >
      <ComboboxTrigger
        render={<Button type="button" size="sm" variant="outline" />}
        className="w-34 justify-start"
        aria-label="Status filters"
      >
        {selected.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {selected.map((status) => (
              <DashboardStatusFilterIcon key={status} status={status} />
            ))}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-70" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-56">
        <div className="border-border/70 border-b px-2 py-1.5">
          <ComboboxInput
            className="[&_input]:h-6.5 [&_input]:rounded-none [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-0 [&_input]:shadow-none [&_input]:focus-visible:ring-0"
            placeholder="Filter statuses"
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No statuses found.</ComboboxEmpty>
        <ComboboxList>
          {filteredStatuses.map((status) => (
            <ComboboxItem key={status} value={status}>
              <span className="flex min-w-0 items-center gap-2">
                <DashboardStatusFilterIcon status={status} />
                <span className="truncate">{ISSUE_STATUS_LABEL[status]}</span>
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
        <div className="border-border/70 border-t p-1.5">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="w-full"
            disabled={selected.length === 0 && query.length === 0}
            onClick={() => {
              setQuery("");
              onChange([]);
            }}
          >
            Clear
          </Button>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

type DashboardSignalFilter = "worktree" | "slack" | "devin";

const DASHBOARD_SIGNAL_FILTER_OPTIONS: ReadonlyArray<{
  value: DashboardSignalFilter;
  label: string;
}> = [
  { value: "worktree", label: "Worktree" },
  { value: "slack", label: "Slack" },
  { value: "devin", label: "Devin" },
];

function selectedSignalFilters(filters: DashboardFilters): DashboardSignalFilter[] {
  const selected: DashboardSignalFilter[] = [];
  if (filters.hasWorktree) {
    selected.push("worktree");
  }
  if (filters.hasSlack) {
    selected.push("slack");
  }
  if (filters.hasDevin) {
    selected.push("devin");
  }
  return selected;
}

function DashboardSignalFilterIcon({ value }: { value: DashboardSignalFilter }) {
  switch (value) {
    case "worktree":
      return <GitBranchPlus className="size-3.5 text-emerald-400" />;
    case "slack":
      return <SlackLogoIcon className="size-3.5" />;
    case "devin":
      return <DevinLogoIcon className="size-3.5" />;
  }
}

function DashboardSignalFilterCombobox({
  filters,
  onChange,
}: {
  filters: DashboardFilters;
  onChange: (partial: Pick<DashboardFilters, "hasWorktree" | "hasSlack" | "hasDevin">) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = selectedSignalFilters(filters);
  const selectedSet = new Set(selected);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredOptions =
    normalizedQuery.length === 0
      ? DASHBOARD_SIGNAL_FILTER_OPTIONS
      : DASHBOARD_SIGNAL_FILTER_OPTIONS.filter(
          (option) =>
            option.label.toLowerCase().includes(normalizedQuery) ||
            option.value.includes(normalizedQuery),
        );
  const selectedLabels = DASHBOARD_SIGNAL_FILTER_OPTIONS.filter((option) =>
    selectedSet.has(option.value),
  ).map((option) => option.label);
  const label =
    selectedLabels.length === 0
      ? "All sources"
      : selectedLabels.length === 1
        ? selectedLabels[0]
        : `${selectedLabels.length} sources`;

  const applySelectedValues = (values: ReadonlyArray<DashboardSignalFilter>) => {
    const next = new Set(values);
    onChange({
      hasWorktree: next.has("worktree"),
      hasSlack: next.has("slack"),
      hasDevin: next.has("devin"),
    });
  };

  return (
    <Combobox<DashboardSignalFilter, true>
      multiple
      items={DASHBOARD_SIGNAL_FILTER_OPTIONS.map((option) => option.value)}
      filteredItems={filteredOptions.map((option) => option.value)}
      value={selected}
      onValueChange={applySelectedValues}
      itemToStringLabel={(value) =>
        DASHBOARD_SIGNAL_FILTER_OPTIONS.find((option) => option.value === value)?.label ?? value
      }
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
        }
      }}
    >
      <ComboboxTrigger
        render={<Button type="button" size="sm" variant="outline" />}
        className="w-34 justify-start"
        aria-label="Source filters"
      >
        {selected.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1">
            {selected.map((value) => (
              <DashboardSignalFilterIcon key={value} value={value} />
            ))}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronDown className="size-3.5 shrink-0 opacity-70" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-56">
        <div className="border-border/70 border-b px-2 py-1.5">
          <ComboboxInput
            className="[&_input]:h-6.5 [&_input]:rounded-none [&_input]:border-0 [&_input]:bg-transparent [&_input]:px-0 [&_input]:shadow-none [&_input]:focus-visible:ring-0"
            placeholder="Filter sources"
            showTrigger={false}
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>No sources found.</ComboboxEmpty>
        <ComboboxList>
          {filteredOptions.map((option) => (
            <ComboboxItem key={option.value} value={option.value}>
              <span className="flex min-w-0 items-center gap-2">
                <DashboardSignalFilterIcon value={option.value} />
                <span className="truncate">{option.label}</span>
              </span>
            </ComboboxItem>
          ))}
        </ComboboxList>
        <div className="border-border/70 border-t p-1.5">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="w-full"
            disabled={selected.length === 0 && query.length === 0}
            onClick={() => {
              setQuery("");
              applySelectedValues([]);
            }}
          >
            Clear
          </Button>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}

export function DashboardToolbar({ projects }: { projects: ReadonlyArray<Project> }) {
  const config = useDashboardViewStore((state) => state.config);
  const setFilters = useDashboardViewStore((state) => state.setFilters);
  const setSort = useDashboardViewStore((state) => state.setSort);

  const updateFilters = (partial: Partial<DashboardFilters>) => {
    setFilters({ ...config.filters, ...partial });
  };

  return (
    <div className="flex flex-col gap-3 border-border border-b px-3 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2 lg:flex-nowrap">
        <label className="relative min-w-44 flex-1 sm:flex-none">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-3.5 text-muted-foreground" />
          <input
            className="h-8 w-full rounded-md border border-input bg-background pr-2 pl-8 text-foreground text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/24 sm:w-56 lg:w-60"
            placeholder="Search issues"
            value={config.filters.searchQuery}
            onChange={(event) => updateFilters({ searchQuery: event.target.value })}
            aria-label="Search dashboard issues"
          />
        </label>

        <ProjectFilterMenu
          projects={projects}
          selectedProjectIds={config.filters.projectIds}
          onChange={(projectIds) => updateFilters({ projectIds })}
        />

        <DashboardStatusFilterCombobox
          selected={config.filters.statuses}
          onChange={(statuses) => updateFilters({ statuses })}
        />

        <DashboardSignalFilterCombobox filters={config.filters} onChange={updateFilters} />

        <Select
          value={config.sortField}
          onValueChange={(value) => setSort(value as SortField, config.sortDirection)}
          items={[
            { value: "updated", label: "Updated" },
            { value: "created", label: "Created" },
          ]}
        >
          <SelectTrigger className="w-28 min-w-28" size="sm" aria-label="Sort field">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="updated">Updated</SelectItem>
            <SelectItem value="created">Created</SelectItem>
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}
