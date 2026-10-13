/**
 * The Tasks tab's label and icon in the right panel's tab bar, plus the
 * surface body. RightPanelTabs and ChatView delegate to these on one marked
 * line each, so Firstmate's name and icon stay in Firstmate's own files.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";

import { readFirstmateName, useFirstmateHome } from "~/state/firstmate";
import { FirstmateIcon } from "./firstmateIcons";
import { FirstmateTasksPanel } from "./FirstmateTasksPanel";

/** The tab is named for Firstmate, so a renamed Firstmate renames its tab. */
export function firstmateTabTitle(): string {
  return readFirstmateName();
}

export function FirstmateTabIcon() {
  const home = useFirstmateHome();
  return <FirstmateIcon icon={home?.snapshot.icon} className="size-3 shrink-0" />;
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
