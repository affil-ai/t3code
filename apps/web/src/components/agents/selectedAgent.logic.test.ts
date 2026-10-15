import {
  AGENT_DEFAULT_COLOR,
  type AgentProfile,
  AgentProfileId,
  FIRSTMATE_AGENT_ID,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSelectedAgent } from "./selectedAgent.logic";

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
