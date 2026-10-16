import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedOfficeThread } from "../../state/office";
import { useWorkModeStore, type WorkFolder } from "../../workModeStore";

/** Stable Slack conversation IDs group threads; labels may change without moving them. */
export function officeFolders(metadata: readonly ScopedOfficeThread[]) {
  const folders = new Map<string, WorkFolder>();
  const threadFolderByKey: Record<string, string> = {};
  for (const entry of metadata) {
    const id = JSON.stringify([
      entry.environmentId,
      entry.workspaceId,
      entry.conversationId ?? "other",
    ]);
    const current = folders.get(id);
    if (
      current === undefined ||
      (isUnresolvedChannelLabel(current.name, entry.conversationId) &&
        !isUnresolvedChannelLabel(entry.label, entry.conversationId))
    ) {
      folders.set(id, {
        id,
        name: entry.label,
        parentId: null,
        createdAt: "1970-01-01T00:00:00.000Z",
      });
    }
    threadFolderByKey[scopedThreadKey(scopeThreadRef(entry.environmentId, entry.threadId))] = id;
  }
  return {
    folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
    threadFolderByKey,
  };
}

/** A failed Slack name lookup is represented by the channel id as its label. */
function isUnresolvedChannelLabel(label: string, conversationId: string | null): boolean {
  return conversationId !== null && label.trim().replace(/^#/, "") === conversationId;
}

/** A desktop-created chat belongs to Work. Office chats enter through Office. */
export function leaveOfficeForPersonalChat() {
  if (useWorkModeStore.getState().mode === "office") useWorkModeStore.getState().setMode("work");
}
