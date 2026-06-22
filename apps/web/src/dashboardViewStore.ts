/**
 * Local-only state for the /dashboard issues view.
 *
 * Holds the current view configuration (filters, sort, list/board mode). This is
 * intentionally in-memory so stale saved views cannot affect the dashboard on load.
 */

import { create } from "zustand";
import {
  EMPTY_FILTERS,
  type DashboardFilters,
  type SortDirection,
  type SortField,
} from "./dashboardIssues";

export type DashboardViewMode = "list" | "board";

export interface DashboardViewConfig {
  filters: DashboardFilters;
  sortField: SortField;
  sortDirection: SortDirection;
  viewMode: DashboardViewMode;
}

export const DEFAULT_VIEW_CONFIG: DashboardViewConfig = {
  filters: EMPTY_FILTERS,
  sortField: "updated",
  sortDirection: "desc",
  viewMode: "list",
};

interface DashboardViewStoreState {
  /** The live, currently-applied configuration. */
  config: DashboardViewConfig;

  setFilters: (filters: DashboardFilters) => void;
  setSort: (field: SortField, direction: SortDirection) => void;
  setViewMode: (mode: DashboardViewMode) => void;
  resetConfig: () => void;
}

export const useDashboardViewStore = create<DashboardViewStoreState>()((set) => ({
  config: DEFAULT_VIEW_CONFIG,

  setFilters: (filters) =>
    set((state) => ({
      config: { ...state.config, filters },
    })),

  setSort: (sortField, sortDirection) =>
    set((state) => ({
      config: { ...state.config, sortField, sortDirection },
    })),

  setViewMode: (viewMode) =>
    set((state) => ({
      config: { ...state.config, viewMode },
    })),

  resetConfig: () => set({ config: DEFAULT_VIEW_CONFIG }),
}));
