import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveFirstmateModelSelection } from "./firstmateModel";

function provider(driver: string, models: readonly string[]): ServerProvider {
  return {
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(driver),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: "2026-10-13T00:00:00.000Z",
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  } as ServerProvider;
}

const providers = [provider("codex", ["gpt-5"]), provider("claudeAgent", ["claude-opus"])];
const base = {
  providers,
  settings: DEFAULT_UNIFIED_SETTINGS,
  scratchProject: null,
  stickyModelSelectionByProvider: {},
  stickyActiveProvider: null,
};

describe("resolveFirstmateModelSelection", () => {
  it("uses the first available provider with no sticky pick", () => {
    expect(resolveFirstmateModelSelection(base)).toMatchObject({
      instanceId: "codex",
      model: "gpt-5",
    });
  });

  it("follows the sticky model a new chat would open with", () => {
    const claude = ProviderInstanceId.make("claudeAgent");
    expect(
      resolveFirstmateModelSelection({
        ...base,
        stickyModelSelectionByProvider: { [claude]: { instanceId: claude, model: "claude-opus" } },
        stickyActiveProvider: claude,
      }),
    ).toMatchObject({ instanceId: "claudeAgent", model: "claude-opus" });
  });

  it("lets the Scratch project's default model outrank the sticky pick", () => {
    const claude = ProviderInstanceId.make("claudeAgent");
    const codex = ProviderInstanceId.make("codex");
    expect(
      resolveFirstmateModelSelection({
        ...base,
        scratchProject: {
          id: "project:scratch",
          defaultModelSelection: { instanceId: codex, model: "gpt-5" },
        } as unknown as EnvironmentProject,
        stickyModelSelectionByProvider: { [claude]: { instanceId: claude, model: "claude-opus" } },
        stickyActiveProvider: claude,
      }),
    ).toMatchObject({ instanceId: "codex", model: "gpt-5" });
  });

  it("returns null when no provider can run a chat", () => {
    expect(resolveFirstmateModelSelection({ ...base, providers: [] })).toBeNull();
  });
});
