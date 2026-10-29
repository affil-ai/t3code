import { createContext, use, useRef } from "react";

import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

// AppSidebarLayout owns this so drawer and Settings remounts preserve the chosen project scope.
// Only route changes may widen that scope; scroll position is lost on remount.
// Leaving Settings commits the router's location before its matches, briefly hiding thread params.
// Ignore null keys so the same thread does not look new during that gap.
export interface SidebarRouteReveal {
  observedKey: string | null;
  pendingKey: string | null;
  /** fork: agents. The observed route, when the sidebar navigated to it itself. */
  claimedKey?: string | null;
}

export const SidebarRouteRevealContext = createContext<SidebarRouteReveal | null>(null);

export function pendingSidebarRouteReveal(
  reveal: SidebarRouteReveal,
  routeKey: string | null,
): string | null {
  if (routeKey === null) return null;
  if (reveal.observedKey !== routeKey) {
    reveal.observedKey = routeKey;
    reveal.pendingKey = routeKey;
    reveal.claimedKey = null;
  }
  return reveal.pendingKey;
}

export function completeSidebarRouteReveal(reveal: SidebarRouteReveal): void {
  reveal.pendingKey = null;
}

// fork: agents. A sidebar row that opens a thread, such as a Work task, is where
// the user is already looking; revealing the thread's own row elsewhere would
// scroll the clicked row away. Claim the route before navigating so the sidebar
// observes it as already settled. History back to it still reveals.
export function claimSidebarRouteReveal(reveal: SidebarRouteReveal, routeKey: string): void {
  reveal.observedKey = routeKey;
  reveal.pendingKey = null;
  reveal.claimedKey = routeKey;
}

// fork: agents. A mount owes one reveal of the open thread, without widening the
// scope. Work's coordinator has no row to reveal, so that debt can outlive the
// mount's own route; a claimed route cancels it.
export function sidebarRouteRevealKey(
  reveal: SidebarRouteReveal,
  mountRevealOwed: { current: boolean },
  routeKey: string | null,
): string | null {
  const pendingKey = pendingSidebarRouteReveal(reveal, routeKey);
  if (pendingKey !== null) return pendingKey;
  if (routeKey === null || !mountRevealOwed.current) return null;
  if (routeKey === reveal.claimedKey) {
    mountRevealOwed.current = false;
    return null;
  }
  return routeKey;
}

export function useClaimSidebarRouteReveal(): (routeKey: string) => void {
  const reveal = use(SidebarRouteRevealContext);
  return (routeKey) => {
    if (reveal !== null) claimSidebarRouteReveal(reveal, routeKey);
  };
}

// Each route change and each mount scroll to the open thread once. Render records
// the route, so a thread left before its row mounted still counts as a change.
// The row can mount after the route, once its shells arrive, so its ref scrolls.
export function useActiveRowReveal(reveal: SidebarRouteReveal, routeKey: string | null) {
  const mountRevealOwed = useRef(true);
  pendingSidebarRouteReveal(reveal, routeKey);
  return (row: HTMLElement | null, rowKey: string) => {
    if (row === null) return;
    // fork: agents. The decision also drops the mount reveal for a claimed route.
    if (sidebarRouteRevealKey(reveal, mountRevealOwed, rowKey) !== rowKey) return;
    completeSidebarRouteReveal(reveal);
    mountRevealOwed.current = false;
    row.scrollIntoView({ block: "nearest" });
  };
}

type RevealableThread = Parameters<typeof filterSidebarV2VisibleThreads>[0][number];

// Render records the route before deciding, so the first render of a new route
// already widens the scope. Only a route reveal widens: the once-per-mount
// scroll never changes a scope the user chose.
export function resolveSidebarRouteReveal<T extends RevealableThread>(input: {
  readonly reveal: SidebarRouteReveal;
  readonly routeKey: string | null;
  readonly isSearching: boolean;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly findThread: (key: string) => T | undefined;
}): { readonly pendingKey: string | null; readonly widensScope: boolean } {
  const { reveal, routeKey, isSearching, scopedProjectKeys, findThread } = input;
  const pendingKey = pendingSidebarRouteReveal(reveal, routeKey);
  // Search results replace the thread list; the reveal waits for it to return.
  const thread = pendingKey === null || isSearching ? undefined : findThread(pendingKey);
  const widensScope =
    thread !== undefined &&
    scopedProjectKeys !== null &&
    filterSidebarV2VisibleThreads([thread], scopedProjectKeys).length === 0 &&
    filterSidebarV2VisibleThreads([thread], null).length === 1;
  return { pendingKey, widensScope };
}
