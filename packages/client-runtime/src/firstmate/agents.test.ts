import {
  AGENT_DEFAULT_COLOR,
  type AgentProfile,
  AgentProfileId,
  FIRSTMATE_AGENT_ID,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  orderAgents,
  reorderAgentIds,
  resolveSelectedAgent,
  sanitizeSelectedAgentData,
} from "./agents.ts";

function agent(id: string, name = id): AgentProfile {
  return {
    id: AgentProfileId.make(id),
    slug: id,
    name,
    icon: "bot",
    color: AGENT_DEFAULT_COLOR,
    role: "",
    coordinatorThreadId: null,
    homeProjectId: null,
  } as AgentProfile;
}

const firstmate = agent(FIRSTMATE_AGENT_ID, "Firstmate");
const chief = agent("chief", "Chief");
const scout = agent("scout", "Scout");

describe("resolveSelectedAgent", () => {
  it("returns null without agents", () => {
    expect(resolveSelectedAgent([], null, false)).toBeNull();
  });

  it("defaults to Firstmate", () => {
    expect(resolveSelectedAgent([chief, firstmate], null, false)).toBe(firstmate);
  });

  it("honours a saved choice that still exists", () => {
    expect(resolveSelectedAgent([firstmate, chief, scout], "scout", false)).toBe(scout);
  });

  it("falls back when the saved choice is gone", () => {
    expect(resolveSelectedAgent([firstmate, chief], "scout", false)).toBe(firstmate);
  });

  it("prefers the first custom agent for a hosted member", () => {
    expect(resolveSelectedAgent([firstmate, chief, scout], null, true)).toBe(chief);
    expect(resolveSelectedAgent([firstmate], null, true)).toBe(firstmate);
  });

  it("uses the first agent when Firstmate is absent", () => {
    expect(resolveSelectedAgent([chief, scout], null, false)).toBe(chief);
  });
});

describe("orderAgents", () => {
  it("keeps the server order without a saved order", () => {
    expect(orderAgents([firstmate, chief, scout], [])).toEqual([firstmate, chief, scout]);
  });

  it("follows the saved order", () => {
    expect(orderAgents([firstmate, chief, scout], ["scout", FIRSTMATE_AGENT_ID, "chief"])).toEqual([
      scout,
      firstmate,
      chief,
    ]);
  });

  it("appends agents the saved order does not know, in server order", () => {
    expect(orderAgents([firstmate, chief, scout], ["scout"])).toEqual([scout, firstmate, chief]);
  });

  it("skips saved ids that no longer exist", () => {
    expect(orderAgents([firstmate, chief], ["gone", "chief"])).toEqual([chief, firstmate]);
  });
});

describe("reorderAgentIds", () => {
  const ids = [FIRSTMATE_AGENT_ID, "chief", "scout"];

  it("moves the dragged agent to the drop target's place", () => {
    expect(reorderAgentIds(ids, "scout", FIRSTMATE_AGENT_ID)).toEqual([
      "scout",
      FIRSTMATE_AGENT_ID,
      "chief",
    ]);
    expect(reorderAgentIds(ids, FIRSTMATE_AGENT_ID, "chief")).toEqual([
      "chief",
      FIRSTMATE_AGENT_ID,
      "scout",
    ]);
  });

  it("leaves the order alone for an unknown id or a drop on itself", () => {
    expect(reorderAgentIds(ids, "chief", "chief")).toBe(ids);
    expect(reorderAgentIds(ids, "gone", "chief")).toBe(ids);
    expect(reorderAgentIds(ids, "chief", null)).toBe(ids);
  });
});

describe("sanitizeSelectedAgentData", () => {
  it("falls back to the defaults for anything malformed", () => {
    const empty = { selectedAgentId: null, preferCustomAgent: false, agentOrder: [] };
    expect(sanitizeSelectedAgentData(undefined)).toEqual(empty);
    expect(sanitizeSelectedAgentData("chief")).toEqual(empty);
    expect(sanitizeSelectedAgentData({ selectedAgentId: "", agentOrder: "chief" })).toEqual(empty);
  });

  it("keeps a valid choice and dedupes the saved order", () => {
    expect(
      sanitizeSelectedAgentData({
        selectedAgentId: "chief",
        preferCustomAgent: true,
        agentOrder: ["chief", 4, "", "scout", "chief"],
      }),
    ).toEqual({
      selectedAgentId: "chief",
      preferCustomAgent: true,
      agentOrder: ["chief", "scout"],
    });
  });
});
