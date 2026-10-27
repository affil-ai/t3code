/**
 * Files forks and agent-created chats in their parent chat's Work project (see
 * `threadParent.logic.ts`). Each recent unfiled chat is checked once per app
 * session. A fork names its parent in its lineage; for other chats the detail
 * is loaded, and a parent marker at the start of the first message files it
 * where the parent is.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useThreadShells } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";
import { useWorkModeStore } from "../../workModeStore";
import { getSidebarForkParentThreadId } from "./workChats.logic";
import {
  parseThreadParentMarker,
  resolveParentWorkProjectId,
  selectThreadParentCandidates,
} from "./threadParent.logic";

const DETAIL_LOAD_TIMEOUT_MS = 15_000;

const checkedKeys = new Set<string>();
const queue: ScopedThreadRef[] = [];
const queuedKeys = new Set<string>();
let draining = false;

/** The first user message's text once the detail is loaded, or null when unknown. */
function firstUserMessageText(state: EnvironmentThreadState): string | null | undefined {
  if (state.status !== "live" && state.status !== "cached") return undefined;
  const thread = Option.getOrNull(state.data);
  if (thread === null) return undefined;
  // A windowed detail may not include the first message.
  if (state.history.hasMoreHistory) return null;
  return thread.messages.find((message) => message.role === "user")?.text ?? null;
}

function readFirstUserMessage(ref: ScopedThreadRef): Promise<string | null> {
  const atom = environmentThreadDetails.stateAtom(ref);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (text: string | null) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      resolve(text);
    };
    const timeout = globalThis.setTimeout(() => finish(null), DETAIL_LOAD_TIMEOUT_MS);
    // Subscribing mounts the thread's detail subscription until we finish.
    unsubscribe = appAtomRegistry.subscribe(
      atom,
      (state) => {
        if (state.status === "deleted") return finish(null);
        const text = firstUserMessageText(state);
        if (text !== undefined) finish(text);
      },
      { immediate: true },
    );
  });
}

async function fileFromParentMarker(ref: ScopedThreadRef): Promise<void> {
  const text = await readFirstUserMessage(ref);
  const parentThreadId = text === null ? null : parseThreadParentMarker(text);
  if (parentThreadId === null) return;
  const store = useWorkModeStore.getState();
  const key = scopedThreadKey(ref);
  // The user may have filed it while we were reading.
  if (store.threadFolderByKey[key] !== undefined) return;
  const projectId = resolveParentWorkProjectId(store, ref.environmentId, parentThreadId);
  if (projectId !== null) store.fileThreads([key], projectId);
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let ref = queue.shift(); ref !== undefined; ref = queue.shift()) {
      const key = scopedThreadKey(ref);
      queuedKeys.delete(key);
      checkedKeys.add(key);
      try {
        await fileFromParentMarker(ref);
      } catch (error) {
        console.warn("Could not check a chat for its parent Work project.", error);
      }
    }
  } finally {
    draining = false;
  }
}

export function useThreadParentFiling(): void {
  const threads = useThreadShells();
  const folders = useWorkModeStore((state) => state.folders);
  const threadFolderByKey = useWorkModeStore((state) => state.threadFolderByKey);

  useEffect(() => {
    // Without a filed chat there is no parent to follow.
    if (Object.keys(threadFolderByKey).length === 0) return;
    // A fork names its parent in its lineage, so it is filed beside the parent
    // directly, without reading a marker from its first message.
    const store = useWorkModeStore.getState();
    for (const thread of threads) {
      if (thread.archivedAt !== null) continue;
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (checkedKeys.has(key) || threadFolderByKey[key] !== undefined) continue;
      const parentThreadId = getSidebarForkParentThreadId(thread);
      if (parentThreadId === null) continue;
      checkedKeys.add(key);
      const projectId = resolveParentWorkProjectId(store, thread.environmentId, parentThreadId);
      if (projectId !== null) store.fileThreads([key], projectId);
    }
    const candidates = selectThreadParentCandidates(
      threads.map((thread) => ({
        key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ref: scopeThreadRef(thread.environmentId, thread.id),
        createdAt: thread.createdAt,
        archivedAt: thread.archivedAt,
        latestUserMessageAt: thread.latestUserMessageAt,
      })),
      { folders, threadFolderByKey },
      checkedKeys,
      Date.now(),
    );
    for (const candidate of candidates) {
      if (queuedKeys.has(candidate.key)) continue;
      queuedKeys.add(candidate.key);
      queue.push(candidate.ref);
    }
    void drain();
  }, [threads, folders, threadFolderByKey]);
}
