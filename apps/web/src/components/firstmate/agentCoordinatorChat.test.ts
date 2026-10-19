import { type AgentProfile, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isAgentCoordinatorChat } from "./agentCoordinatorChat";

const environmentId = EnvironmentId.make("work");
const home = {
  environmentId,
  agents: [{ coordinatorThreadId: ThreadId.make("chief") } as AgentProfile],
};

describe("isAgentCoordinatorChat", () => {
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
