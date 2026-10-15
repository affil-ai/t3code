/**
 * Which agent the Work sidebar shows. Firstmate is the default and keeps the
 * Pinned, Projects, and Chats sections; any other agent shows only its tasks
 * and automations. The choice belongs to this app or browser only. A hosted
 * sign-in that is not Vivek's prefers the first custom agent until the user
 * picks one.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const SELECTED_AGENT_STORAGE_KEY = "t3work:selected-agent:v1";

export interface SelectedAgentData {
  /** The chosen agent id, or null for Firstmate (or the hosted preference). */
  selectedAgentId: string | null;
  /** Without an explicit choice, open the first custom agent instead of Firstmate. */
  preferCustomAgent: boolean;
}

export function sanitizeSelectedAgentData(value: unknown): SelectedAgentData {
  const raw =
    value && typeof value === "object"
      ? (value as { selectedAgentId?: unknown; preferCustomAgent?: unknown })
      : {};
  return {
    selectedAgentId:
      typeof raw.selectedAgentId === "string" && raw.selectedAgentId !== ""
        ? raw.selectedAgentId
        : null,
    preferCustomAgent: raw.preferCustomAgent === true,
  };
}

interface SelectedAgentStore extends SelectedAgentData {
  selectAgent: (agentId: string | null) => void;
  setPreferCustomAgent: (prefer: boolean) => void;
}

export const useSelectedAgentStore = create<SelectedAgentStore>()(
  persist(
    (set) => ({
      selectedAgentId: null,
      preferCustomAgent: false,
      selectAgent: (selectedAgentId) => set({ selectedAgentId }),
      setPreferCustomAgent: (preferCustomAgent) => set({ preferCustomAgent }),
    }),
    {
      name: SELECTED_AGENT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        selectedAgentId: state.selectedAgentId,
        preferCustomAgent: state.preferCustomAgent,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitizeSelectedAgentData(persisted) }),
    },
  ),
);
