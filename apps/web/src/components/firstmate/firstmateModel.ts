/**
 * The model "Start Firstmate" sends: the one a new chat in the Scratch project
 * would open with. It strings together the composer's own resolvers in the
 * order a fresh draft goes through them, so no Firstmate-specific rule exists.
 */
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ModelSelection,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useMemo } from "react";

import { deriveEffectiveComposerModelState, useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { resolveNewThreadModelSelectionOverride } from "~/lib/chatThreadActions";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  NO_PROVIDER_MODEL_SELECTION,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { resolveComposerProviderSelection } from "../ChatView.logic";
import { getComposerProviderState } from "../chat/composerProviderState";

export interface FirstmateModelInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  /** The Scratch project, or null before the server has created it. */
  readonly scratchProject: EnvironmentProject | null;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  readonly stickyActiveProvider: ProviderInstanceId | null;
}

/** The selection a fresh Scratch draft would send, or null when no provider can run it. */
export function resolveFirstmateModelSelection(input: FirstmateModelInput): ModelSelection | null {
  const projectId = input.scratchProject?.id ?? null;
  const projectDefault =
    resolveProjectSettings(input.settings, projectId, input.scratchProject ?? undefined).settings
      .defaultModelSelection ?? null;
  // useHandleNewThread: sticky state first, then the project default replaces
  // its instance's entry. The Firstmate page is not a chat, so nothing carries.
  const override = resolveNewThreadModelSelectionOverride({
    projectDefaultSelection: projectDefault,
    carrySelection: null,
    carrySourceDraftId: null,
    destinationDraftId: "",
  });
  const draft = {
    modelSelectionByProvider: {
      ...input.stickyModelSelectionByProvider,
      ...(override ? { [override.instanceId]: override } : {}),
    },
    activeProvider: override?.instanceId ?? input.stickyActiveProvider,
  };
  // ChatView: an unstarted draft's thread selection is the project default.
  const threadModelSelection = projectDefault ?? NO_PROVIDER_MODEL_SELECTION;
  // ChatComposer: pick the instance, then the model and its options.
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(input.providers),
      input.settings,
      projectId,
    ),
  );
  const { selectedProviderEntry, requestedDriverKind } = resolveComposerProviderSelection({
    entries,
    candidateInstanceIds: [
      draft.activeProvider,
      undefined,
      threadModelSelection.instanceId,
      projectDefault?.instanceId,
    ],
    lockedProvider: null,
    lockedInstanceId: undefined,
  });
  if (selectedProviderEntry === undefined) return null;
  const selectedInstanceId = selectedProviderEntry.instanceId;
  const selectedProvider = selectedProviderEntry.driverKind ?? requestedDriverKind;
  const { selectedModel, modelOptions } = deriveEffectiveComposerModelState({
    draft,
    providers: input.providers,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection,
    projectModelSelection: projectDefault,
    settings: input.settings,
  });
  const { modelOptionsForDispatch } = getComposerProviderState({
    provider: selectedProvider,
    model: selectedModel,
    models: selectedProviderEntry.models,
    modelOptions: modelOptions?.[selectedInstanceId],
    planModeEnabled: input.settings.planModeEnabled,
  });
  return createModelSelection(selectedInstanceId, selectedModel, modelOptionsForDispatch);
}

/** Live version of `resolveFirstmateModelSelection` for one environment. */
export function useFirstmateModelSelection(environmentId: EnvironmentId): ModelSelection | null {
  const settings = useEnvironmentSettings(environmentId);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const projects = useProjects();
  const stickyModelSelectionByProvider = useComposerDraftStore(
    (store) => store.stickyModelSelectionByProvider,
  );
  const stickyActiveProvider = useComposerDraftStore((store) => store.stickyActiveProvider);
  const scratchWorkspaceRoot = serverConfig?.scratchWorkspaceRoot ?? null;
  const scratchProject = useMemo(
    () =>
      projects.find(
        (project) =>
          project.environmentId === environmentId &&
          isScratchProject(project, scratchWorkspaceRoot),
      ) ?? null,
    [environmentId, projects, scratchWorkspaceRoot],
  );
  const providers = useEnvironmentProviders().get(environmentId);
  return useMemo(
    () =>
      providers === undefined
        ? null
        : resolveFirstmateModelSelection({
            providers,
            settings,
            scratchProject,
            stickyModelSelectionByProvider,
            stickyActiveProvider,
          }),
    [providers, scratchProject, settings, stickyActiveProvider, stickyModelSelectionByProvider],
  );
}
