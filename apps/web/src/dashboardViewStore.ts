/**
 * Local-only persistence for the /dashboard issues view.
 *
 * Holds the current view configuration (filters, sort, list/board mode) plus a set of
 * named "saved views" with one optional default. Everything is persisted to localStorage
 * via the same zustand `persist` pattern used by {@link ./panelLayoutStore}; there is no
 * backend for this — it is per-browser UI state.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  EMPTY_FILTERS,
  type DashboardFilters,
  type SortDirection,
  type SortField,
} from "./dashboardIssues";
import { resolveStorage } from "./lib/storage";

export const DASHBOARD_VIEW_STORAGE_KEY = "t3code:dashboard-views:v1";

export type DashboardViewMode = "list" | "board";

export interface DashboardViewConfig {
  filters: DashboardFilters;
  sortField: SortField;
  sortDirection: SortDirection;
  viewMode: DashboardViewMode;
}

export interface SavedDashboardView extends DashboardViewConfig {
  id: string;
  name: string;
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
  savedViews: SavedDashboardView[];
  /** Id of the saved view applied by default on load, if any. */
  defaultViewId: string | null;
  /** Id of the saved view currently applied (cleared when config diverges). */
  activeViewId: string | null;

  setFilters: (filters: DashboardFilters) => void;
  setSort: (field: SortField, direction: SortDirection) => void;
  setViewMode: (mode: DashboardViewMode) => void;
  saveView: (name: string) => string;
  applyView: (id: string) => void;
  deleteView: (id: string) => void;
  setDefaultView: (id: string | null) => void;
  resetConfig: () => void;
}

function createDashboardViewStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

const SORT_FIELDS: ReadonlyArray<SortField> = ["updated", "created"];
const SORT_DIRECTIONS: ReadonlyArray<SortDirection> = ["asc", "desc"];
const VIEW_MODES: ReadonlyArray<DashboardViewMode> = ["list", "board"];

/**
 * Coerce a (possibly hand-edited or schema-drifted) persisted config back into a valid
 * one, falling back to defaults for any field that isn't a known value. Guards the
 * Select/ToggleGroup controls from ever receiving a value outside their option set.
 */
function sanitizeConfig(config: Partial<DashboardViewConfig> | undefined): DashboardViewConfig {
  const filters = config?.filters;
  return {
    filters: {
      statuses: Array.isArray(filters?.statuses) ? filters.statuses : EMPTY_FILTERS.statuses,
      hasWorktree: filters?.hasWorktree === true,
      hasSlack: filters?.hasSlack === true,
    },
    sortField: SORT_FIELDS.includes(config?.sortField as SortField)
      ? (config?.sortField as SortField)
      : DEFAULT_VIEW_CONFIG.sortField,
    sortDirection: SORT_DIRECTIONS.includes(config?.sortDirection as SortDirection)
      ? (config?.sortDirection as SortDirection)
      : DEFAULT_VIEW_CONFIG.sortDirection,
    viewMode: VIEW_MODES.includes(config?.viewMode as DashboardViewMode)
      ? (config?.viewMode as DashboardViewMode)
      : DEFAULT_VIEW_CONFIG.viewMode,
  };
}

/** Deterministic-enough id for a saved view without relying on Date.now/Math.random call sites. */
function nextViewId(existing: ReadonlyArray<SavedDashboardView>): string {
  let maxNumeric = 0;
  for (const view of existing) {
    const match = /^view-(\d+)$/u.exec(view.id);
    if (match) {
      maxNumeric = Math.max(maxNumeric, Number(match[1]));
    }
  }
  return `view-${maxNumeric + 1}`;
}

export const useDashboardViewStore = create<DashboardViewStoreState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_VIEW_CONFIG,
      savedViews: [],
      defaultViewId: null,
      activeViewId: null,

      setFilters: (filters) =>
        set((state) => ({
          config: { ...state.config, filters },
          activeViewId: null,
        })),

      setSort: (sortField, sortDirection) =>
        set((state) => ({
          config: { ...state.config, sortField, sortDirection },
          activeViewId: null,
        })),

      setViewMode: (viewMode) =>
        set((state) => ({
          config: { ...state.config, viewMode },
          activeViewId: null,
        })),

      saveView: (name) => {
        const trimmed = name.trim();
        const id = nextViewId(get().savedViews);
        set((state) => ({
          savedViews: [
            ...state.savedViews,
            { id, name: trimmed.length > 0 ? trimmed : id, ...state.config },
          ],
          activeViewId: id,
        }));
        return id;
      },

      applyView: (id) =>
        set((state) => {
          const view = state.savedViews.find((candidate) => candidate.id === id);
          if (!view) {
            return state;
          }
          const { id: _id, name: _name, ...config } = view;
          return { config: sanitizeConfig(config), activeViewId: id };
        }),

      deleteView: (id) =>
        set((state) => ({
          savedViews: state.savedViews.filter((view) => view.id !== id),
          defaultViewId: state.defaultViewId === id ? null : state.defaultViewId,
          activeViewId: state.activeViewId === id ? null : state.activeViewId,
        })),

      setDefaultView: (id) =>
        set((state) => ({
          defaultViewId:
            id === null ? null : state.savedViews.some((view) => view.id === id) ? id : null,
        })),

      resetConfig: () => set({ config: DEFAULT_VIEW_CONFIG, activeViewId: null }),
    }),
    {
      name: DASHBOARD_VIEW_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createDashboardViewStorage),
      // Only saved views and the default selection are persisted; the live config is derived
      // (in `merge`) from the default view, so it is never written to storage directly.
      partialize: (state) => ({
        savedViews: state.savedViews,
        defaultViewId: state.defaultViewId,
      }),
      // Merge persisted state into the initial state without mutating either. When a default
      // view is set, open the dashboard with that view's (sanitized) config applied.
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<
          Pick<DashboardViewStoreState, "savedViews" | "defaultViewId">
        >;
        const savedViews = Array.isArray(stored.savedViews) ? stored.savedViews : [];
        const defaultViewId =
          typeof stored.defaultViewId === "string" &&
          savedViews.some((view) => view.id === stored.defaultViewId)
            ? stored.defaultViewId
            : null;
        const defaultView = defaultViewId
          ? savedViews.find((view) => view.id === defaultViewId)
          : undefined;
        return {
          ...current,
          savedViews,
          defaultViewId,
          config: defaultView ? sanitizeConfig(defaultView) : current.config,
          activeViewId: defaultView ? defaultView.id : null,
        };
      },
    },
  ),
);
