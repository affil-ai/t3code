/**
 * The model a new agent chat starts with: the one a new thread in the
 * Scratch project would open with, using the same resolvers as the new-task
 * flow. Web's `firstmateModel.ts` follows the same order with its composer's
 * resolvers: the Scratch project's default, then the last model used, then
 * the first available model.
 */
import type { ModelSelection, ProjectId, ServerConfig } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";

import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";

export function resolveDefaultAgentModelSelection(input: {
  readonly config: ServerConfig | null;
  /** The Scratch project, or null before the server has created it. */
  readonly scratchProject: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null;
  /** The model last picked in the composer. */
  readonly stickySelection: ModelSelection | null;
}): ModelSelection | null {
  if (input.config === null) return null;
  const projectId = input.scratchProject?.id ?? null;
  const settings = input.config.settings ?? DEFAULT_SERVER_SETTINGS;
  const projectDefaultSelection = resolveDefaultableModelSelection(
    input.config,
    resolveProjectSettings(settings, projectId, input.scratchProject).settings
      .defaultModelSelection,
    projectId,
  );
  const stickySelection = resolveDefaultableModelSelection(
    input.config,
    input.stickySelection,
    projectId,
  );
  return resolveNewTaskModelSelection({
    draftSelection: null,
    projectDefaultSelection,
    stickySelection,
    modelOptions: buildModelOptions(
      input.config,
      projectDefaultSelection ?? stickySelection,
      undefined,
      projectId,
    ),
  });
}
