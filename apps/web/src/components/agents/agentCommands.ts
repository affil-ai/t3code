import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { agentsEnvironment } from "~/state/agents";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type AgentCommandKind = "create" | "update" | "archive" | "start";

/**
 * Agents mode's mutations with one pending flag and an error toast. Each run
 * resolves to the command's value, or null when it failed.
 */
export function useAgentCommands() {
  const [pending, setPending] = useState<AgentCommandKind | null>(null);
  const create = useAtomCommand(agentsEnvironment.create, { reportFailure: false });
  const update = useAtomCommand(agentsEnvironment.update, { reportFailure: false });
  const archive = useAtomCommand(agentsEnvironment.archive, { reportFailure: false });
  const start = useAtomCommand(agentsEnvironment.start, { reportFailure: false });
  const run = useCallback(
    async <A, E>(
      kind: AgentCommandKind,
      execute: () => Promise<AtomCommandResult<A, E>>,
      failureTitle: string,
    ): Promise<A | null> => {
      setPending(kind);
      const result = await execute();
      setPending(null);
      if (result._tag === "Success") return result.value;
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failureTitle,
            description: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
      return null;
    },
    [],
  );
  return { pending, create, update, archive, start, run };
}

/** Shows the Tasks tab beside an agent's chat. Agents share Firstmate's pinned surface. */
export function openAgentTasks(environmentId: EnvironmentId, threadId: ThreadId) {
  useRightPanelStore.getState().open(scopeThreadRef(environmentId, threadId), "firstmate");
}
