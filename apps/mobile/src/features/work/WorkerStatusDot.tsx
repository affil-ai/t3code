import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { useThreadShell } from "../../state/entities";
import { resolveThreadListV2Status, threadHasUnseenCompletion } from "../threads/threadListV2";
import { workerStatusPresentation } from "./workStatus";

/**
 * A task's worker chat status as a small dot: working, waiting on you, failed,
 * or newly finished. Draws nothing for an idle chat or one not loaded yet.
 */
export function WorkerStatusDot(props: {
  readonly environmentId: EnvironmentId;
  readonly workerThreadId: ThreadId;
  readonly size?: number;
}) {
  const shell = useThreadShell(scopeThreadRef(props.environmentId, props.workerThreadId));
  const status =
    shell === null
      ? null
      : workerStatusPresentation(
          resolveThreadListV2Status(shell),
          threadHasUnseenCompletion(shell),
        );
  if (status === null) return null;
  const size = props.size ?? 6;
  return (
    <View
      accessible
      accessibilityLabel={status.label}
      className={status.dotClassName}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  );
}
