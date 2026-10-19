/**
 * A draft session held outside the composer draft store, such as the right
 * panel's new chat, which must not add a sidebar draft row. The store ignores
 * drafts it does not hold, so BranchToolbar and its branch picker read and
 * write such a draft through this context instead.
 */
import { createContext, useContext } from "react";

import { type DraftSessionState, useComposerDraftStore } from "../composerDraftStore";

export type DraftThreadContextPatch = Parameters<
  ReturnType<typeof useComposerDraftStore.getState>["setDraftThreadContext"]
>[1];

export interface LocalDraftSession {
  draft: DraftSessionState;
  update: (patch: DraftThreadContextPatch) => void;
}

export const LocalDraftSessionContext = createContext<LocalDraftSession | null>(null);

export function useLocalDraftSession(): LocalDraftSession | null {
  return useContext(LocalDraftSessionContext);
}

/**
 * The store's `setDraftThreadContext` for a draft that stays in its project:
 * workspace, branch, and mode fields only. Project and environment changes
 * are ignored.
 */
export function applyLocalDraftContextPatch(
  existing: DraftSessionState,
  patch: DraftThreadContextPatch,
): DraftSessionState {
  const worktreePath =
    patch.worktreePath === undefined ? existing.worktreePath : (patch.worktreePath ?? null);
  return {
    ...existing,
    branch: patch.branch === undefined ? existing.branch : (patch.branch ?? null),
    worktreePath,
    envMode: patch.envMode ?? (worktreePath ? "worktree" : existing.envMode),
    startFromOrigin: patch.startFromOrigin ?? existing.startFromOrigin,
    runtimeMode: patch.runtimeMode ?? existing.runtimeMode,
    interactionMode: patch.interactionMode ?? existing.interactionMode,
  };
}
