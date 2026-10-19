import { describe, expect, it } from "vite-plus/test";
import { workRepositories } from "./workRepositories";

describe("Work repository navigation", () => {
  it("preserves grouped local and remote repositories and their order", () => {
    const fork = {
      isScratch: false,
      memberProjects: [{ physicalProjectKey: "mac:fork" }, { physicalProjectKey: "ubuntu:fork" }],
    };
    const nextcard = { memberProjects: [{ physicalProjectKey: "ubuntu:nextcard" }] };
    expect(workRepositories([fork, nextcard], new Set())).toEqual([fork, nextcard]);
    expect(workRepositories([fork], new Set())[0]).toBe(fork);
  });
  it("excludes Scratch and coordinator homes without hiding other repositories", () => {
    const projects = [
      { isScratch: true, memberProjects: [{ physicalProjectKey: "mac:scratch" }] },
      { memberProjects: [{ physicalProjectKey: "ubuntu:agent" }] },
      { memberProjects: [{ physicalProjectKey: "ubuntu:fork" }] },
    ];
    expect(workRepositories(projects, new Set(["ubuntu:agent"]))).toEqual([projects[2]]);
    expect(workRepositories([], new Set())).toEqual([]);
  });
});
