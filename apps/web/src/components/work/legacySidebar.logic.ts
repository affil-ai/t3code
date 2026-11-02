// fork: work mode. Helpers the legacy sidebar still uses after upstream removed
// its own legacy sidebar (#21039, #26238). Kept here so upstream files carry no
// fork exports.
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ContextMenuItem } from "@t3tools/contracts";

import { desktopLocalBackendId } from "../../connection/desktopLocal";

export const ORCHESTRATION_OPERATE_DENIED_MESSAGE =
  "This connection cannot change threads or projects.";

const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
const SIDEBAR_THREAD_PREWARM_LIMIT = 3;

export function isWslConnectionTarget(target: ConnectionTarget): boolean {
  return desktopLocalBackendId(target)?.startsWith("wsl:") === true;
}

/** The key of a project's per-project grouping override. */
export function deriveProjectGroupingOverrideKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string {
  return derivePhysicalProjectKey(project);
}

export function buildMultiSelectThreadContextMenuItems(input: {
  count: number;
  hasRunningThread: boolean;
}): readonly ContextMenuItem<"mark-unread" | "archive" | "delete">[] {
  return [
    { id: "mark-unread", label: `Mark unread (${input.count})` },
    {
      id: "archive",
      label: `Archive (${input.count})`,
      disabled: input.hasRunningThread,
    },
    { id: "delete", label: `Delete (${input.count})`, destructive: true },
  ];
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}
