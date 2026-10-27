import { useEffect, useSyncExternalStore, type Dispatch } from "react";

import type { WorkspaceTab, WorkspaceTabsAction } from "../workspace/workspace-tabs-state";
import { useWorkTabAvailable } from "../work/WorkTabState";

/**
 * Lets the showcase coordinator, which renders above the workspace, choose the
 * workspace tab. The tab state lives in each `WorkspaceTabsProvider`, so every
 * provider applies the request and reports the tab it shows.
 */
const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";

let requestedTab: WorkspaceTab | null = null;
let selectedTab: WorkspaceTab | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getRequestedTab(): WorkspaceTab | null {
  return requestedTab;
}

function getSelectedTab(): WorkspaceTab | null {
  return selectedTab;
}

export function requestShowcaseWorkspaceTab(tab: WorkspaceTab): void {
  if (requestedTab === tab) return;
  requestedTab = tab;
  emit();
}

/** The tab a workspace tab controller last reported, or null before any has. */
export function useShowcaseSelectedWorkspaceTab(): WorkspaceTab | null {
  return useSyncExternalStore(subscribe, getSelectedTab, getSelectedTab);
}

/** Called by `WorkspaceTabsProvider`. Does nothing outside showcase builds. */
export function useShowcaseWorkspaceTab(
  currentTab: WorkspaceTab,
  dispatch: Dispatch<WorkspaceTabsAction>,
): void {
  const requested = useSyncExternalStore(subscribe, getRequestedTab, getRequestedTab);
  const workAvailable = useWorkTabAvailable();
  useEffect(() => {
    if (!SHOWCASE_ENABLED) return;
    if (selectedTab !== currentTab) {
      selectedTab = currentTab;
      emit();
    }
    // Work hides until a server answers agents; selecting it earlier would
    // fight the Work tab's own fallback to Threads, one switch per render.
    if (requested === "work" && !workAvailable) return;
    if (requested !== null && requested !== currentTab) {
      dispatch({ type: "select", tab: requested });
    }
  }, [currentTab, dispatch, requested, workAvailable]);
}
