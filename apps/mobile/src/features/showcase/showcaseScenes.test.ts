import { describe, expect, it } from "vite-plus/test";

import { resolveShowcaseScene } from "./showcaseScenes";

describe("resolveShowcaseScene", () => {
  it("reads the Work tab from the workspace root", () => {
    expect(
      resolveShowcaseScene({ pathname: "/", requestedScene: "work", selectedTab: "work" }),
    ).toBe("work");
    expect(
      resolveShowcaseScene({ pathname: "/", requestedScene: "work", selectedTab: "threads" }),
    ).toBe("threads");
  });

  it("treats the root as the thread list until a tab controller reports", () => {
    expect(resolveShowcaseScene({ pathname: "/", requestedScene: null, selectedTab: null })).toBe(
      "threads",
    );
    expect(
      resolveShowcaseScene({
        pathname: "/",
        requestedScene: "agent-activity",
        selectedTab: "threads",
      }),
    ).toBe("agent-activity");
    expect(
      resolveShowcaseScene({ pathname: "/", requestedScene: null, selectedTab: "pullRequests" }),
    ).toBeNull();
  });

  it("recognizes the Work routes", () => {
    expect(
      resolveShowcaseScene({
        pathname: "/work/env-1/tasks/fm-cold-start",
        requestedScene: "work-task",
        selectedTab: "work",
      }),
    ).toBe("work-task");
  });

  it("keeps the existing thread routes", () => {
    const scene = (pathname: string) =>
      resolveShowcaseScene({ pathname, requestedScene: null, selectedTab: "threads" });
    expect(scene("/threads/env-1/remote-command-center")).toBe("thread");
    expect(scene("/threads/env-1/remote-command-center/terminal")).toBe("terminal");
    expect(scene("/threads/env-1/remote-command-center/review")).toBe("review");
    expect(scene("/settings/environments")).toBe("environments");
  });
});
