import { describe, expect, it } from "vite-plus/test";

import { visibleWorkspaceTabs, workTabAvailable, workTabSelection } from "./WorkTab.logic";

describe("workTabAvailable", () => {
  it("shows Work while a connected server serves it", () => {
    expect(
      workTabAvailable({
        liveEnvironmentId: "env-a",
        rememberedEnvironmentId: null,
        savedEnvironmentIds: [],
      }),
    ).toBe(true);
  });

  it("keeps Work through a reconnect while its environment is still saved", () => {
    const input = { liveEnvironmentId: null, rememberedEnvironmentId: "env-a" };
    expect(workTabAvailable({ ...input, savedEnvironmentIds: ["env-a", "env-b"] })).toBe(true);
    expect(workTabAvailable({ ...input, savedEnvironmentIds: ["env-b"] })).toBe(false);
  });

  it("hides Work when only stock servers are connected", () => {
    expect(
      workTabAvailable({
        liveEnvironmentId: null,
        rememberedEnvironmentId: null,
        savedEnvironmentIds: ["env-a"],
      }),
    ).toBe(false);
  });
});

describe("visibleWorkspaceTabs", () => {
  it("leads with Work only when it is available", () => {
    expect(visibleWorkspaceTabs(true)).toEqual(["work", "threads", "pullRequests"]);
    expect(visibleWorkspaceTabs(false)).toEqual(["threads", "pullRequests"]);
  });
});

describe("workTabSelection", () => {
  it("picks Work once when it arrives before the user has chosen a tab", () => {
    const first = workTabSelection({
      available: true,
      selectedTab: "threads",
      selectionRevision: 0,
      defaultSettled: false,
    });
    expect(first).toEqual({ tab: "work", defaultSettled: true });
    // After the user goes back to Threads, Work never takes over again.
    expect(
      workTabSelection({
        available: true,
        selectedTab: "threads",
        selectionRevision: 2,
        defaultSettled: first.defaultSettled,
      }),
    ).toEqual({ tab: null, defaultSettled: true });
  });

  it("leaves a tab the user picked before Work arrived", () => {
    const waiting = workTabSelection({
      available: false,
      selectedTab: "pullRequests",
      selectionRevision: 1,
      defaultSettled: false,
    });
    expect(waiting).toEqual({ tab: null, defaultSettled: true });
    expect(
      workTabSelection({
        available: true,
        selectedTab: "pullRequests",
        selectionRevision: 1,
        defaultSettled: waiting.defaultSettled,
      }),
    ).toEqual({ tab: null, defaultSettled: true });
  });

  it("does not pick Work while it is unavailable", () => {
    expect(
      workTabSelection({
        available: false,
        selectedTab: "threads",
        selectionRevision: 0,
        defaultSettled: false,
      }),
    ).toEqual({ tab: null, defaultSettled: false });
  });

  it("falls back to Threads when Work goes away", () => {
    expect(
      workTabSelection({
        available: false,
        selectedTab: "work",
        selectionRevision: 1,
        defaultSettled: true,
      }),
    ).toEqual({ tab: "threads", defaultSettled: true });
  });
});
