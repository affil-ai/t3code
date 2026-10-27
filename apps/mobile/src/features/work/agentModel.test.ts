import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultAgentModelSelection } from "./agentModel";

const codex = ProviderInstanceId.make("codex");
const config = {
  settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: null },
  providers: [
    {
      instanceId: codex,
      driver: "codex",
      displayName: "Codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [
        { slug: "first", name: "First", isCustom: false, capabilities: null },
        { slug: "default", name: "Default", isDefault: true, isCustom: false, capabilities: null },
        { slug: "sticky", name: "Sticky", isCustom: false, capabilities: null },
        { slug: "scratch", name: "Scratch", isCustom: false, capabilities: null },
      ],
    },
  ],
} as unknown as ServerConfig;

describe("resolveDefaultAgentModelSelection", () => {
  it("waits for the server config", () => {
    expect(
      resolveDefaultAgentModelSelection({
        config: null,
        scratchProject: null,
        stickySelection: null,
      }),
    ).toBeNull();
  });

  it("uses the advertised default with nothing picked", () => {
    expect(
      resolveDefaultAgentModelSelection({ config, scratchProject: null, stickySelection: null }),
    ).toEqual({ instanceId: codex, model: "default" });
  });

  it("follows the last model used, and lets the Scratch project's default outrank it", () => {
    const stickySelection = { instanceId: codex, model: "sticky" };
    expect(
      resolveDefaultAgentModelSelection({ config, scratchProject: null, stickySelection }),
    ).toEqual(stickySelection);
    expect(
      resolveDefaultAgentModelSelection({
        config,
        scratchProject: {
          id: ProjectId.make("scratch"),
          defaultModelSelection: { instanceId: codex, model: "scratch" },
        },
        stickySelection,
      }),
    ).toEqual({ instanceId: codex, model: "scratch" });
  });
});
