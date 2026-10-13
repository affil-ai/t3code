/**
 * Work mode's pinned chats. Pins belong to this app or browser only: they are
 * kept in local storage and never sent to the shared Work state.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const WORK_PINNED_STORAGE_KEY = "t3work:pinned-threads:v1";

export interface WorkPinnedData {
  /** Scoped thread keys, most recently pinned first. */
  pinnedThreadKeys: string[];
}

export function togglePinnedThread(data: WorkPinnedData, threadKey: string): WorkPinnedData {
  return {
    pinnedThreadKeys: data.pinnedThreadKeys.includes(threadKey)
      ? data.pinnedThreadKeys.filter((key) => key !== threadKey)
      : [threadKey, ...data.pinnedThreadKeys],
  };
}

export function sanitizePinnedData(value: unknown): WorkPinnedData {
  const raw = value && typeof value === "object" ? (value as { pinnedThreadKeys?: unknown }) : {};
  const keys = Array.isArray(raw.pinnedThreadKeys)
    ? raw.pinnedThreadKeys.filter((key): key is string => typeof key === "string" && key !== "")
    : [];
  return { pinnedThreadKeys: [...new Set(keys)] };
}

interface WorkPinnedStore extends WorkPinnedData {
  togglePinned: (threadKey: string) => void;
}

export const useWorkPinnedStore = create<WorkPinnedStore>()(
  persist(
    (set) => ({
      pinnedThreadKeys: [],
      togglePinned: (threadKey) => set((state) => togglePinnedThread(state, threadKey)),
    }),
    {
      name: WORK_PINNED_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ pinnedThreadKeys: state.pinnedThreadKeys }),
      merge: (persisted, current) => ({ ...current, ...sanitizePinnedData(persisted) }),
    },
  ),
);

export function useIsThreadPinned(threadKey: string): boolean {
  return useWorkPinnedStore((state) => state.pinnedThreadKeys.includes(threadKey));
}
