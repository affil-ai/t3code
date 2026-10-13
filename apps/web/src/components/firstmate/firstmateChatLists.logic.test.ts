import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NO_FIRSTMATE_COORDINATOR_KEYS,
  firstmateCoordinatorThreadKeys,
} from "./firstmateChatLists.logic";

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
