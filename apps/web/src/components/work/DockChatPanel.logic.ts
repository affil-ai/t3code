/** Pure helpers for the dock chat panel, kept apart from its ChatView-bound component. */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

const TITLE_MAX_LENGTH = 60;

/** A short thread title from the first message, as the composer's first line. */
export function deriveDockChatTitle(text: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0) return "New chat";
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : firstLine;
}

/** Other chats, most recent first. The host thread is excluded. */
export function listDockChatCandidates(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  hostThreadRef: ScopedThreadRef,
  lineageThreadKeys: ReadonlySet<string> = new Set(),
): EnvironmentThreadShell[] {
  const recency = (thread: EnvironmentThreadShell) =>
    Date.parse(thread.latestUserMessageAt ?? thread.updatedAt) || 0;
  return threads
    .filter(
      (thread) =>
        (thread.archivedAt === null ||
          lineageThreadKeys.has(
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          )) &&
        !(
          thread.environmentId === hostThreadRef.environmentId &&
          thread.id === hostThreadRef.threadId
        ),
    )
    .toSorted((left, right) => recency(right) - recency(left));
}

export interface DockChatSection {
  id: "lineage" | "repo";
  title: string;
  threads: EnvironmentThreadShell[];
}

/**
 * Related chats in up to two sections: the host's lineage, then the rest of its
 * repository project. Chats in other projects are not listed. A chat appears
 * once, lineage first, most recent first. Empty sections are dropped.
 */
export function sectionDockChatCandidates(input: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  hostThreadRef: ScopedThreadRef;
  hostProjectId: string;
  repoTitle: string;
  /** Scoped keys of the host's immediate parent, forks, and subagents. */
  lineageThreadKeys?: ReadonlySet<string>;
}): DockChatSection[] {
  const { hostThreadRef, hostProjectId, repoTitle } = input;
  const lineageThreadKeys = input.lineageThreadKeys ?? new Set<string>();
  const inLineage: EnvironmentThreadShell[] = [];
  const inRepo: EnvironmentThreadShell[] = [];
  for (const thread of listDockChatCandidates(input.threads, hostThreadRef, lineageThreadKeys)) {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (lineageThreadKeys.has(threadKey)) {
      inLineage.push(thread);
    } else if (
      thread.environmentId === hostThreadRef.environmentId &&
      thread.projectId === hostProjectId
    ) {
      inRepo.push(thread);
    }
  }
  const sections: DockChatSection[] = [
    { id: "lineage", title: "Lineage", threads: inLineage },
    { id: "repo", title: `In ${repoTitle}`, threads: inRepo },
  ];
  return sections.filter((section) => section.threads.length > 0);
}
