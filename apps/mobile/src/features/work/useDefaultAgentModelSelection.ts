import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, ModelSelection } from "@t3tools/contracts";

import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useStickyComposerModelSelection } from "../../state/use-composer-drafts";
import { resolveDefaultAgentModelSelection } from "./agentModel";

/**
 * The model for `agents.create`, `agents.start`, and `firstmate.start` on one
 * environment: what a new Scratch thread would open with. Null while the
 * server config loads or when no provider can run a chat.
 */
export function useDefaultAgentModelSelection(
  environmentId: EnvironmentId | null,
): ModelSelection | null {
  const config = useEnvironmentServerConfig(environmentId);
  const projects = useProjects();
  const stickySelection = useStickyComposerModelSelection();
  const scratchProject =
    config === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === environmentId &&
            isScratchProject(project, config.scratchWorkspaceRoot),
        ) ?? null);
  return resolveDefaultAgentModelSelection({ config, scratchProject, stickySelection });
}
