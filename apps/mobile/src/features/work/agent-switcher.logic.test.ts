import { FIRSTMATE_AGENT_ID, type AgentProfile, type ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentPresentation, agentRoleLine, moveAgent } from "./agent-switcher.logic";

function agent(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: "scout",
    slug: "scout",
    name: "Scout",
    icon: "compass",
    color: "sky",
    role: "Finds leads\nMore detail",
    coordinatorThreadId: "thread-scout",
    homeProjectId: null,
    modelSelection: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  } as AgentProfile;
}

describe("agentPresentation", () => {
  it("takes Firstmate's name, icon, and chat from its own stream", () => {
    const firstmate = agent({
      id: FIRSTMATE_AGENT_ID,
      name: "Firstmate",
      coordinatorThreadId: null,
    });
    expect(
      agentPresentation(firstmate, {
        name: "Ada",
        icon: "rocket",
        coordinatorThreadId: "thread-fm" as ThreadId,
      }),
    ).toEqual({ name: "Ada", icon: "rocket", coordinatorThreadId: "thread-fm" });
  });

  it("uses the agent row for every other agent", () => {
    expect(
      agentPresentation(agent({}), {
        name: "Ada",
        icon: "rocket",
        coordinatorThreadId: "thread-fm" as ThreadId,
      }),
    ).toEqual({ name: "Scout", icon: "compass", coordinatorThreadId: "thread-scout" });
  });
});

describe("agentRoleLine", () => {
  it("shows the role's first line, or that the agent has no chat yet", () => {
    const scout = agent({});
    expect(agentRoleLine(scout, scout.coordinatorThreadId)).toBe("Finds leads");
    expect(agentRoleLine(scout, null)).toBe("Not started");
    expect(agentRoleLine(agent({ id: FIRSTMATE_AGENT_ID, role: "" }), "t" as ThreadId)).toBe(
      "Your coordinator",
    );
  });
});

describe("moveAgent", () => {
  const ids = ["firstmate", "scout", "growth"];

  it("swaps the agent with its neighbour", () => {
    expect(moveAgent(ids, "scout", "up")).toEqual(["scout", "firstmate", "growth"]);
    expect(moveAgent(ids, "scout", "down")).toEqual(["firstmate", "growth", "scout"]);
  });

  it("keeps the order at either end or for an unknown agent", () => {
    expect(moveAgent(ids, "firstmate", "up")).toBe(ids);
    expect(moveAgent(ids, "growth", "down")).toBe(ids);
    expect(moveAgent(ids, "missing", "up")).toBe(ids);
  });
});
