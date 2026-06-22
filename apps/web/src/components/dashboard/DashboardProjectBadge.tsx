import { IconCloud as CloudIcon } from "@tabler/icons-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings, type ProjectGroupingSettings } from "../../logicalProject";
import {
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import type { Project } from "../../types";
import { ProjectFavicon } from "../ProjectFavicon";
import { Badge } from "../ui/badge";

type DashboardProjectIconSource =
  | { kind: "cloud" }
  | {
      kind: "favicon";
      environmentId: EnvironmentId;
      cwd: string;
    };

interface DashboardProjectSnapshotCache {
  projects: ReadonlyArray<Project>;
  sidebarProjectGroupingMode: ProjectGroupingSettings["sidebarProjectGroupingMode"];
  sidebarProjectGroupingOverrides: ProjectGroupingSettings["sidebarProjectGroupingOverrides"];
  primaryEnvironmentId: EnvironmentId | null;
  snapshotsByProjectRef: Map<string, SidebarProjectSnapshot>;
}

let dashboardProjectSnapshotCache: DashboardProjectSnapshotCache | null = null;

function projectRefKey(environmentId: EnvironmentId, projectId: Project["id"]): string {
  return `${environmentId}:${projectId}`;
}

function getDashboardProjectSnapshotsByRef(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): ReadonlyMap<string, SidebarProjectSnapshot> {
  const cached = dashboardProjectSnapshotCache;
  if (
    cached &&
    cached.projects === input.projects &&
    cached.sidebarProjectGroupingMode === input.settings.sidebarProjectGroupingMode &&
    cached.sidebarProjectGroupingOverrides === input.settings.sidebarProjectGroupingOverrides &&
    cached.primaryEnvironmentId === input.primaryEnvironmentId
  ) {
    return cached.snapshotsByProjectRef;
  }

  const sidebarProjects = buildSidebarProjectSnapshots({
    projects: input.projects,
    settings: input.settings,
    primaryEnvironmentId: input.primaryEnvironmentId,
    resolveEnvironmentLabel: () => null,
  });
  const snapshotsByProjectRef = new Map<string, SidebarProjectSnapshot>();
  for (const sidebarProject of sidebarProjects) {
    for (const member of sidebarProject.memberProjects) {
      snapshotsByProjectRef.set(projectRefKey(member.environmentId, member.id), sidebarProject);
    }
  }

  dashboardProjectSnapshotCache = {
    projects: input.projects,
    sidebarProjectGroupingMode: input.settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: input.settings.sidebarProjectGroupingOverrides,
    primaryEnvironmentId: input.primaryEnvironmentId,
    snapshotsByProjectRef,
  };
  return snapshotsByProjectRef;
}

function useDashboardProjectIconSource(project: Project): DashboardProjectIconSource {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));

  const sidebarProject = useMemo(() => {
    const snapshotsByProjectRef = getDashboardProjectSnapshotsByRef({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
    });
    return snapshotsByProjectRef.get(projectRefKey(project.environmentId, project.id)) ?? null;
  }, [
    primaryEnvironmentId,
    project.environmentId,
    project.id,
    projectGroupingSettings.sidebarProjectGroupingMode,
    projectGroupingSettings.sidebarProjectGroupingOverrides,
    projects,
  ]);

  if (sidebarProject?.environmentPresence === "remote-only") {
    return { kind: "cloud" };
  }

  return {
    kind: "favicon",
    environmentId: sidebarProject?.environmentId ?? project.environmentId,
    cwd: sidebarProject?.cwd ?? project.cwd,
  };
}

export function DashboardProjectIcon({ project }: { project: Project }) {
  const iconSource = useDashboardProjectIconSource(project);
  return iconSource.kind === "cloud" ? (
    <CloudIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
  ) : (
    <ProjectFavicon environmentId={iconSource.environmentId} cwd={iconSource.cwd} />
  );
}

export function DashboardProjectName({ project }: { project: Project }) {
  return <span className="truncate">{project.name}</span>;
}

export function DashboardProjectBadge({ project }: { project: Project }) {
  return (
    <Badge variant="outline" size="sm" title={project.cwd}>
      <DashboardProjectIcon project={project} />
      <DashboardProjectName project={project} />
    </Badge>
  );
}
