import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { useAgentsHome, useTaskByWorkerThreadKey } from "~/state/agents";
import { CoordinatorThreadContext } from "./firstmateTasksShared";
import { TaskDetail } from "./FirstmateTaskDetail";

export function TaskDetailsSurface({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const task = useTaskByWorkerThreadKey().get(scopedThreadKey(threadRef)) ?? null;
  const agentsHome = useAgentsHome();
  const coordinatorThreadId =
    agentsHome?.agents.find((agent) => agent.coordinatorThreadId !== null)?.coordinatorThreadId ??
    null;
  if (task === null) return null;
  return (
    <CoordinatorThreadContext.Provider value={coordinatorThreadId}>
      <TaskDetail environmentId={threadRef.environmentId} task={task} />
    </CoordinatorThreadContext.Provider>
  );
}
