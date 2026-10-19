import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, FirstmateTask } from "@t3tools/contracts";
import { StarIcon } from "lucide-react";
import { useState } from "react";
import { firstmateEnvironment } from "~/state/firstmate";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";

export function TaskPriorityStar() {
  return (
    <StarIcon
      role="img"
      aria-label="Priority"
      className="inline size-3.5 shrink-0 fill-warning text-warning"
    />
  );
}

export function TaskPriorityToggle({
  environmentId,
  task,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
}) {
  const permitted = useAtomValue(
    firstmateEnvironment.setTaskPriority.permissionAtom(environmentId),
  );
  const setPriority = useAtomCommand(firstmateEnvironment.setTaskPriority);
  const [pending, setPending] = useState(false);
  // An old server cannot save the field. Do not offer a nonfunctional control.
  if (task.priority === undefined) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={!permitted || pending}
      aria-pressed={task.priority}
      onClick={() => {
        setPending(true);
        void setPriority({
          environmentId,
          input: { taskId: task.id, priority: !task.priority },
        }).finally(() => setPending(false));
      }}
    >
      {task.priority ? <TaskPriorityStar /> : <StarIcon aria-hidden />}
      {task.priority ? "Remove priority" : "Mark as priority"}
    </Button>
  );
}
