/**
 * Filing agent-created chats in their parent's Work project.
 *
 * Work projects exist only in this client, so an agent that creates a chat
 * through a server's orchestration API cannot file it. Instead it starts the
 * chat's first message with a parent marker naming the chat it was created
 * from. The client reads the marker from each new unfiled chat and files the
 * chat where its parent is. The server stays unmodified: the marker is plain
 * message text, hidden when the message is shown.
 */
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";

import { resolveThreadWorkProjectId, type WorkModeData } from "../../workModeStore";

const THREAD_PARENT_MARKER_PATTERN =
  /^\s*<!--\s*t3work-parent:\s*([A-Za-z0-9._-]+)\s*-->[ \t]*\r?\n?/;

/** How long after creation a chat is still checked for a parent marker. */
export const THREAD_PARENT_CHECK_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/** The parent thread ID named at the start of a chat's first message, if any. */
export function parseThreadParentMarker(text: string): string | null {
  return THREAD_PARENT_MARKER_PATTERN.exec(text)?.[1] ?? null;
}

/** The message text without its leading parent marker. */
export function stripThreadParentMarker(text: string): string {
  return text.replace(THREAD_PARENT_MARKER_PATTERN, "");
}

/**
 * The Work project of the parent thread. The marker carries only the thread
 * ID, because agents do not know the client's environment IDs; a parent in
 * the child's own environment wins over one elsewhere.
 */
export function resolveParentWorkProjectId(
  data: Pick<WorkModeData, "folders" | "threadFolderByKey">,
  childEnvironmentId: string,
  parentThreadId: string,
): string | null {
  let elsewhere: string | null = null;
  for (const threadKey of Object.keys(data.threadFolderByKey)) {
    const ref = parseScopedThreadKey(threadKey);
    if (ref === null || ref.threadId !== parentThreadId) continue;
    const projectId = resolveThreadWorkProjectId(data, threadKey);
    if (projectId === null) continue;
    if (ref.environmentId === childEnvironmentId) return projectId;
    elsewhere ??= projectId;
  }
  return elsewhere;
}

export interface ThreadParentCandidate {
  key: string;
  createdAt: string;
  archivedAt: string | null;
  latestUserMessageAt: string | null;
}

/**
 * Chats worth checking for a parent marker: recent, unarchived, unfiled, not
 * yet checked, and with a first message to read. Oldest first, so a parent
 * created by an agent is filed before its own children.
 */
export function selectThreadParentCandidates<T extends ThreadParentCandidate>(
  threads: ReadonlyArray<T>,
  data: Pick<WorkModeData, "folders" | "threadFolderByKey">,
  checkedKeys: ReadonlySet<string>,
  now: number,
): T[] {
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.latestUserMessageAt !== null &&
        !checkedKeys.has(thread.key) &&
        now - Date.parse(thread.createdAt) <= THREAD_PARENT_CHECK_WINDOW_MS &&
        resolveThreadWorkProjectId(data, thread.key) === null,
    )
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}
