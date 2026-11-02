/**
 * fork: work mode. How many threads each legacy sidebar project shows before
 * "Show more". Upstream removed the `sidebarThreadPreviewCount` client setting
 * with its own legacy sidebar (#21039), so the Work sidebar keeps the value on
 * this device.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

export const MIN_SIDEBAR_THREAD_PREVIEW_COUNT = 1;
export const MAX_SIDEBAR_THREAD_PREVIEW_COUNT = 15;
const DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT = 6;

export type SidebarThreadPreviewCount = number;

interface LegacySidebarPreviewCountState {
  count: SidebarThreadPreviewCount;
  setCount: (count: SidebarThreadPreviewCount) => void;
}

function clampPreviewCount(value: unknown): SidebarThreadPreviewCount {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT;
  }
  return Math.min(
    MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
    Math.max(MIN_SIDEBAR_THREAD_PREVIEW_COUNT, Math.trunc(value)),
  );
}

export const useLegacySidebarPreviewCountStore = create<LegacySidebarPreviewCountState>()(
  persist(
    (set) => ({
      count: DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
      setCount: (count) => set({ count: clampPreviewCount(count) }),
    }),
    {
      name: "t3work:sidebar-thread-preview-count:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ count: state.count }),
      merge: (persisted, current) => ({
        ...current,
        count: clampPreviewCount((persisted as { count?: unknown } | undefined)?.count),
      }),
    },
  ),
);

export function useSidebarThreadPreviewCount(): SidebarThreadPreviewCount {
  return useLegacySidebarPreviewCountStore((state) => state.count);
}

export function setSidebarThreadPreviewCount(count: SidebarThreadPreviewCount): void {
  useLegacySidebarPreviewCountStore.getState().setCount(count);
}
