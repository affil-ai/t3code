import type { WorkspaceTab } from "../workspace/workspace-tabs-state";

/** Keep in step with `SHOWCASE_SCENES` in scripts/mobile-showcase-environment.ts. */
export const SHOWCASE_SCENES = [
  "threads",
  "thread",
  "terminal",
  "review",
  "environments",
  "agent-activity",
  // fork: work
  "work",
  "work-task",
  "work-agent-editor",
] as const;
export type ShowcaseScene = (typeof SHOWCASE_SCENES)[number];

/** The seeded Firstmate task the work-task scene opens (scripts/mobile-showcase-work.ts). */
export const SHOWCASE_WORK_TASK_ID = "fm-cold-start";

/** Firstmate plus five seeded agents, enough for the switcher's compact grid. */
export const SHOWCASE_WORK_AGENT_COUNT = 6;

export function isWorkShowcaseScene(scene: ShowcaseScene): boolean {
  return scene === "work" || scene === "work-task" || scene === "work-agent-editor";
}

/** The workspace tab a scene shows; on wide layouts it is the sidebar beside the detail. */
export function showcaseWorkspaceTab(scene: ShowcaseScene): WorkspaceTab {
  return isWorkShowcaseScene(scene) ? "work" : "threads";
}

function sceneFromPathname(pathname: string): ShowcaseScene | null {
  const routePath = pathname.split(/[?#]/u, 1)[0] ?? pathname;
  if (routePath.startsWith("/work/")) {
    if (routePath.includes("/tasks/")) return "work-task";
    if (routePath.includes("/agents/edit")) return "work-agent-editor";
    return null;
  }
  if (routePath === "/settings" || routePath.endsWith("/settings/environments")) {
    return "environments";
  }
  if (routePath.endsWith("/terminal")) return "terminal";
  if (routePath.endsWith("/review")) return "review";
  if (routePath.startsWith("/threads/")) return "thread";
  if (routePath === "/") return "threads";
  return null;
}

/** Scenes shown on the workspace root, which differ only by tab or staged activity. */
export function isWorkspaceRootShowcaseScene(scene: ShowcaseScene): boolean {
  return scene === "threads" || scene === "work" || scene === "agent-activity";
}

export function isShowcaseWorkspaceRoot(pathname: string): boolean {
  return sceneFromPathname(pathname) === "threads";
}

/**
 * The scene on screen. The workspace root serves three scenes: the thread
 * list, the Work tab, and the agent-activity capture staged over the list.
 * `selectedTab` is null until a workspace tab controller reports, which
 * means the default thread list.
 */
export function resolveShowcaseScene(input: {
  readonly pathname: string;
  readonly requestedScene: ShowcaseScene | null;
  readonly selectedTab: WorkspaceTab | null;
}): ShowcaseScene | null {
  const routeScene = sceneFromPathname(input.pathname);
  if (routeScene !== "threads") return routeScene;
  const tab = input.selectedTab ?? "threads";
  if (tab === "work") return "work";
  if (tab !== "threads") return null;
  return input.requestedScene === "agent-activity" ? "agent-activity" : "threads";
}
