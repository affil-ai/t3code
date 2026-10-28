/**
 * When the workspace shows the Work tab, and when it picks it for the user.
 * Work needs this fork's server: a stock server has no agents or Firstmate,
 * so its tab stays hidden and the workspace keeps Threads.
 */
import type { WorkspaceTab } from "../workspace/workspace-tabs-state";

/**
 * Work shows while a connected environment serves agents. Once
 * one has this session, the tab stays while that environment is still
 * saved, so a reconnect does not pull the tab out from under the user,
 * until that environment connects and refuses agents (a stock server).
 */
export function workTabAvailable(input: {
  readonly liveEnvironmentId: string | null;
  readonly rememberedEnvironmentId: string | null;
  /** The remembered environment is connected and its agents stream failed. */
  readonly rememberedUnsupported: boolean;
  readonly savedEnvironmentIds: ReadonlyArray<string>;
}): boolean {
  if (input.liveEnvironmentId !== null) return true;
  if (input.rememberedUnsupported) return false;
  return (
    input.rememberedEnvironmentId !== null &&
    input.savedEnvironmentIds.includes(input.rememberedEnvironmentId)
  );
}

/**
 * The workspace tabs in display order: the user's enabled navigation tabs, led
 * by Work when the server has it. Work is not one of the customizable
 * navigation tabs, so it is never hidden or reordered with them.
 */
export function visibleWorkspaceTabs<Tab extends WorkspaceTab>(
  workAvailable: boolean,
  navigationTabs: ReadonlyArray<Tab>,
): ReadonlyArray<Tab | "work"> {
  return workAvailable
    ? ["work", ...navigationTabs.filter((tab) => tab !== "work")]
    : navigationTabs;
}

/**
 * How many navigation tabs fit beside Work in a bar that holds `capacity`
 * navigation tabs (Settings comes on top of either).
 */
export function navigationTabCapacity(capacity: number, workAvailable: boolean): number {
  return workAvailable ? Math.max(1, capacity - 1) : capacity;
}

/**
 * The tab to switch to, if any, as Work comes and goes:
 * - Work selected but gone: back to Threads.
 * - Work arriving before the user has picked a tab this session: Work, once.
 *   A tab the user picked first is left alone.
 *
 * `defaultSettled` records that the first-time choice has been made, by
 * either side, so it is never made again.
 */
export function workTabSelection(input: {
  readonly available: boolean;
  readonly selectedTab: WorkspaceTab;
  /** How many times the selection has changed this session. */
  readonly selectionRevision: number;
  readonly defaultSettled: boolean;
}): { readonly tab: WorkspaceTab | null; readonly defaultSettled: boolean } {
  if (!input.available) {
    return {
      tab: input.selectedTab === "work" ? "threads" : null,
      // A tab picked before Work arrives is still the user's choice.
      defaultSettled: input.defaultSettled || input.selectionRevision > 0,
    };
  }
  if (input.defaultSettled) return { tab: null, defaultSettled: true };
  const untouched = input.selectionRevision === 0 && input.selectedTab === "threads";
  return { tab: untouched ? "work" : null, defaultSettled: true };
}
