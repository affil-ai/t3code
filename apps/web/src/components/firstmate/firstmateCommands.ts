import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useCallback, useState } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { firstmateEnvironment } from "~/state/firstmate";
import { useAtomCommand } from "~/state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type FirstmateCommandKind = "start" | "setCoordinator" | "setAppearance";

/**
 * Firstmate's mutations with one pending flag and an error toast. Each run
 * resolves to the command's value, or null when it failed.
 */
export function useFirstmateCommands() {
  const [pending, setPending] = useState<FirstmateCommandKind | null>(null);
  const start = useAtomCommand(firstmateEnvironment.start, { reportFailure: false });
  const setCoordinator = useAtomCommand(firstmateEnvironment.setCoordinator, {
    reportFailure: false,
  });
  const setAppearance = useAtomCommand(firstmateEnvironment.setAppearance, {
    reportFailure: false,
  });
  const run = useCallback(
    async <A, E>(
      kind: FirstmateCommandKind,
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
  return { pending, start, setCoordinator, setAppearance, run };
}

/** Shows the Tasks tab beside the coordinator chat. */
export function openFirstmateTasks(environmentId: EnvironmentId, threadId: ThreadId) {
  useRightPanelStore.getState().open(scopeThreadRef(environmentId, threadId), "firstmate");
}
