import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { FirstmateTaskId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useRightPanelStore } from "~/rightPanelStore";

/**
 * Worker task Details is only an inline panel on wide layouts. Remember each
 * thread/task pair after opening it so task updates and resizes cannot reopen a
 * panel the user closed. // fork: firstmate
 */
export function useAutoOpenWorkerTaskDetails(
  threadRef: ScopedThreadRef | null,
  taskId: FirstmateTaskId | null,
  shouldUsePlanSidebarSheet: boolean,
): void {
  const autoOpenedTaskKeys = useRef(new Set<string>());

  useEffect(() => {
    if (threadRef === null || taskId === null) return;

    const taskKey = `${scopedThreadKey(threadRef)}:${taskId}`;
    if (autoOpenedTaskKeys.current.has(taskKey)) return;

    autoOpenedTaskKeys.current.add(taskKey);
    if (shouldUsePlanSidebarSheet) return;

    useRightPanelStore.getState().open(threadRef, "task-details");
  }, [shouldUsePlanSidebarSheet, taskId, threadRef]);
}
