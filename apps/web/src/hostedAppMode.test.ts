import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createMemoryStorage } from "./lib/storage";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DEV", false);
  vi.stubGlobal("window", {
    location: { origin: "https://t3.olumbe.com" },
    localStorage: createMemoryStorage(),
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ email: "vivek@affil.ai" })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function loadAppMode() {
  const hosted = await import("./hostedAppMode");
  const { useWorkModeStore, WORK_MODE_STORAGE_KEY } = await import("./workModeStore");
  return { ...hosted, useWorkModeStore, WORK_MODE_STORAGE_KEY };
}

describe("hosted identity default", () => {
  it.each([
    ["vivek@affil.ai", false],
    ["VIVEK@AFFIL.AI", false],
    ["another@affil.ai", true],
    ["vivek@example.com", true],
  ])("maps %s to Work, preferring a custom agent: %s", async (email, preferCustomAgent) => {
    const { getIdentityDefault, getIdentityDefaultAppMode } = await loadAppMode();

    expect(getIdentityDefault({ email })).toEqual({ mode: "work", preferCustomAgent });
    expect(getIdentityDefaultAppMode({ email })).toBe("work");
  });

  it.each([null, {}, { email: "" }, { email: " " }, { email: 42 }])(
    "keeps the existing default without an identity email: %j",
    async (identity) => {
      vi.mocked(fetch).mockResolvedValue(Response.json(identity));
      const { initializeHostedAppMode, useWorkModeStore } = await loadAppMode();
      const initialMode = useWorkModeStore.getState().mode;

      await initializeHostedAppMode();

      expect(useWorkModeStore.getState().mode).toBe(initialMode);
      expect(useWorkModeStore.getState().hasExplicitMode).toBe(false);
    },
  );

  it("resolves and caches the default without saving the email", async () => {
    const { initializeHostedAppMode, useWorkModeStore, WORK_MODE_STORAGE_KEY } =
      await loadAppMode();

    await initializeHostedAppMode();

    expect(fetch).toHaveBeenCalledWith("/cdn-cgi/access/get-identity", {
      credentials: "same-origin",
      signal: expect.any(AbortSignal),
    });
    expect(useWorkModeStore.getState().mode).toBe("work");
    expect(useWorkModeStore.getState().hasExplicitMode).toBe(false);
    expect(window.localStorage.getItem(WORK_MODE_STORAGE_KEY)).not.toContain("vivek@affil.ai");

    vi.resetModules();
    const reloaded = await loadAppMode();
    expect(reloaded.useWorkModeStore.getState().mode).toBe("work");
    expect(reloaded.useWorkModeStore.getState().hasExplicitMode).toBe(false);

    vi.mocked(fetch).mockResolvedValue(Response.json({ email: "another@affil.ai" }));
    await reloaded.initializeHostedAppMode();
    expect(reloaded.useWorkModeStore.getState().mode).toBe("work");
    const { useSelectedAgentStore } = await import("./selectedAgentStore");
    expect(useSelectedAgentStore.getState().preferCustomAgent).toBe(true);
  });

  it("reads a saved Agents mode as Work", async () => {
    const { WORK_MODE_STORAGE_KEY } = await loadAppMode();
    window.localStorage.setItem(
      WORK_MODE_STORAGE_KEY,
      JSON.stringify({ state: { mode: "agents" }, version: 1 }),
    );
    vi.resetModules();
    const { useWorkModeStore } = await loadAppMode();

    expect(useWorkModeStore.getState().mode).toBe("work");
    expect(useWorkModeStore.getState().hasExplicitMode).toBe(true);
  });

  it.each(["code", "work", "office"] as const)(
    "preserves a legacy saved %s mode as an explicit choice",
    async (mode) => {
      const { WORK_MODE_STORAGE_KEY } = await loadAppMode();
      window.localStorage.setItem(
        WORK_MODE_STORAGE_KEY,
        JSON.stringify({ state: { mode }, version: 1 }),
      );
      vi.resetModules();
      const { initializeHostedAppMode, useWorkModeStore } = await loadAppMode();

      await initializeHostedAppMode();

      expect(useWorkModeStore.getState().mode).toBe(mode);
      expect(useWorkModeStore.getState().hasExplicitMode).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("persists an explicit choice even when the chosen mode is already the default", async () => {
    const { initializeHostedAppMode, useWorkModeStore } = await loadAppMode();
    await initializeHostedAppMode();
    useWorkModeStore.getState().setMode("work");

    vi.resetModules();
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValue(Response.json({ email: "another@affil.ai" }));
    const reloaded = await loadAppMode();
    await reloaded.initializeHostedAppMode();
    reloaded.useWorkModeStore.getState().applyIdentityDefault("office");

    expect(reloaded.useWorkModeStore.getState().mode).toBe("work");
    expect(reloaded.useWorkModeStore.getState().hasExplicitMode).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not overwrite a choice made while the identity request is pending", async () => {
    let resolveIdentity!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveIdentity = resolve;
      }),
    );
    const { initializeHostedAppMode, useWorkModeStore } = await loadAppMode();
    const initialized = initializeHostedAppMode();
    useWorkModeStore.getState().setMode("office");
    resolveIdentity(Response.json({ email: "vivek@affil.ai" }));

    await initialized;

    expect(useWorkModeStore.getState().mode).toBe("office");
    expect(useWorkModeStore.getState().hasExplicitMode).toBe(true);
  });

  it.each([new Response("<html>Sign in</html>"), new Response(null, { status: 403 })])(
    "keeps the existing default for an unusable Access response",
    async (response) => {
      vi.mocked(fetch).mockResolvedValue(response);
      const { initializeHostedAppMode, useWorkModeStore } = await loadAppMode();

      await initializeHostedAppMode();

      expect(useWorkModeStore.getState().mode).toBe("code");
    },
  );

  it("keeps the cached default when the Access request fails", async () => {
    const { initializeHostedAppMode } = await loadAppMode();
    await initializeHostedAppMode();
    vi.resetModules();
    vi.mocked(fetch).mockRejectedValue(new Error("Access unavailable"));
    const reloaded = await loadAppMode();

    await reloaded.initializeHostedAppMode();

    expect(reloaded.useWorkModeStore.getState().mode).toBe("work");
    expect(reloaded.useWorkModeStore.getState().hasExplicitMode).toBe(false);
  });

  it.each(["http://localhost:5733", "https://other.example.com", "http://t3.olumbe.com"])(
    "leaves the default unchanged on %s",
    async (origin) => {
      vi.stubGlobal("window", { location: { origin }, localStorage: createMemoryStorage() });
      const { initializeHostedAppMode, useWorkModeStore } = await loadAppMode();

      await initializeHostedAppMode();

      expect(useWorkModeStore.getState().mode).toBe("code");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("leaves the desktop default unchanged even on the hosted origin", async () => {
    vi.stubGlobal("window", {
      location: { origin: "https://t3.olumbe.com" },
      localStorage: createMemoryStorage(),
      desktopBridge: {},
    });
    const { initializeHostedAppMode, useWorkModeStore } = await loadAppMode();

    await initializeHostedAppMode();

    expect(useWorkModeStore.getState().mode).toBe("code");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves development builds unchanged even on the hosted origin", async () => {
    vi.stubEnv("DEV", true);
    const { initializeHostedAppMode, useWorkModeStore } = await loadAppMode();

    await initializeHostedAppMode();

    expect(useWorkModeStore.getState().mode).toBe("code");
    expect(fetch).not.toHaveBeenCalled();
  });
});
