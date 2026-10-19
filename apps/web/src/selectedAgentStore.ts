/**
 * Which agent the Work sidebar shows. Firstmate is the default and keeps the
 * Pinned, Projects, and Chats sections; any other agent shows only its tasks
 * and automations. The choice, and the order of the agent tabs, belong to this
 * app or browser only, like pinned chats. A hosted
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
  /** Agent ids in the user's tab order; empty keeps the server's order. */
  agentOrder: string[];
}

export function sanitizeSelectedAgentData(value: unknown): SelectedAgentData {
  const raw =
    value && typeof value === "object"
      ? (value as { selectedAgentId?: unknown; preferCustomAgent?: unknown; agentOrder?: unknown })
      : {};
  return {
    selectedAgentId:
      typeof raw.selectedAgentId === "string" && raw.selectedAgentId !== ""
        ? raw.selectedAgentId
        : null,
    preferCustomAgent: raw.preferCustomAgent === true,
    agentOrder: Array.isArray(raw.agentOrder)
      ? [
          ...new Set(
            raw.agentOrder.filter((id): id is string => typeof id === "string" && id !== ""),
          ),
        ]
      : [],
  };
}

interface SelectedAgentStore extends SelectedAgentData {
  selectAgent: (agentId: string | null) => void;
  setPreferCustomAgent: (prefer: boolean) => void;
  setAgentOrder: (agentOrder: ReadonlyArray<string>) => void;
}

export const useSelectedAgentStore = create<SelectedAgentStore>()(
  persist(
    (set) => ({
      selectedAgentId: null,
      preferCustomAgent: false,
      agentOrder: [],
      selectAgent: (selectedAgentId) => set({ selectedAgentId }),
      setPreferCustomAgent: (preferCustomAgent) => set({ preferCustomAgent }),
      setAgentOrder: (agentOrder) => set({ agentOrder: [...agentOrder] }),
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
        agentOrder: state.agentOrder,
      }),
      merge: (persisted, current) => ({ ...current, ...sanitizeSelectedAgentData(persisted) }),
    },
  ),
);
