import { type AgentProfile, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NO_FIRSTMATE_COORDINATOR_KEYS,
  NO_FIRSTMATE_HOME_PROJECT_KEYS,
  firstmateCoordinatorThreadKeys,
  agentCoordinatorThreadKeys,
  agentHomeProjectKeys,
  firstmateHomeProjectKeys,
  isAgentCoordinatorChat,
} from "./chatLists.ts";

const local = EnvironmentId.make("env-local");
const coordinator = ThreadId.make("thread-coordinator");

describe("firstmateCoordinatorThreadKeys", () => {
  it("is empty without an environment or a coordinator", () => {
    expect(firstmateCoordinatorThreadKeys(null, coordinator)).toBe(NO_FIRSTMATE_COORDINATOR_KEYS);
    expect(firstmateCoordinatorThreadKeys(local, null)).toBe(NO_FIRSTMATE_COORDINATOR_KEYS);
  });

  it("holds the coordinator's scoped key", () => {
    expect(firstmateCoordinatorThreadKeys(local, coordinator).size).toBe(1);
  });
});

describe("firstmateHomeProjectKeys", () => {
  it("is empty until a start has made the home project, or on an older server", () => {
    expect(firstmateHomeProjectKeys(local, null)).toBe(NO_FIRSTMATE_HOME_PROJECT_KEYS);
    expect(firstmateHomeProjectKeys(local, undefined)).toBe(NO_FIRSTMATE_HOME_PROJECT_KEYS);
    expect(firstmateHomeProjectKeys(null, ProjectId.make("home"))).toBe(
      NO_FIRSTMATE_HOME_PROJECT_KEYS,
    );
  });

  it("holds the home project's scoped key", () => {
    expect([...firstmateHomeProjectKeys(local, ProjectId.make("home"))]).toEqual([
      "env-local:home",
    ]);
  });
});

describe("isAgentCoordinatorChat", () => {
  const environmentId = EnvironmentId.make("work");
  const home = {
    environmentId,
    agents: [{ coordinatorThreadId: ThreadId.make("chief") } as AgentProfile],
  };

  it("is true only for an agent's coordinator chat in the agents' environment", () => {
    expect(isAgentCoordinatorChat(home, environmentId, ThreadId.make("chief"))).toBe(true);
    expect(isAgentCoordinatorChat(home, environmentId, ThreadId.make("worker"))).toBe(false);
    expect(isAgentCoordinatorChat(home, EnvironmentId.make("mac"), ThreadId.make("chief"))).toBe(
      false,
    );
    expect(isAgentCoordinatorChat(null, environmentId, ThreadId.make("chief"))).toBe(false);
    expect(isAgentCoordinatorChat(home, environmentId, null)).toBe(false);
  });
});

describe("agent chat and project keys", () => {
  const environmentId = EnvironmentId.make("work");
  const home = {
    environmentId,
    agents: [
      {
        coordinatorThreadId: ThreadId.make("chief"),
        homeProjectId: ProjectId.make("chief-home"),
      } as AgentProfile,
      { coordinatorThreadId: null, homeProjectId: null } as AgentProfile,
    ],
  };

  it("keys every coordinator chat and home project that exists", () => {
    expect([...agentCoordinatorThreadKeys(home)]).toEqual([
      ...firstmateCoordinatorThreadKeys(environmentId, ThreadId.make("chief")),
    ]);
    expect([...agentHomeProjectKeys(home)]).toEqual([
      ...firstmateHomeProjectKeys(environmentId, ProjectId.make("chief-home")),
    ]);
    expect(agentCoordinatorThreadKeys(null).size).toBe(0);
  });
});
