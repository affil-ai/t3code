/**
 * The Tasks tab's label and icon in the right panel's tab bar, plus the
 * surface body. RightPanelTabs and ChatView delegate to these on one marked
 * line each. The tab is always "Tasks" with a checklist icon; Firstmate's
 * custom name and icon stay on the sidebar row and the chat.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";

import { ListChecksIcon } from "lucide-react";

import { FirstmateTasksPanel } from "./FirstmateTasksPanel";

export const FIRSTMATE_TASKS_TITLE = "Tasks";

export function firstmateTabTitle(): string {
  return FIRSTMATE_TASKS_TITLE;
}

export function FirstmateTabIcon() {
  return <ListChecksIcon className="size-3 shrink-0" />;
}

export function FirstmateTasksSurface({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  return (
    <FirstmateTasksPanel
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      environmentId={threadRef.environmentId}
      threadId={threadRef.threadId}
    />
  );
}
