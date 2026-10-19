import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NO_FIRSTMATE_COORDINATOR_KEYS,
  NO_FIRSTMATE_HOME_PROJECT_KEYS,
  firstmateCoordinatorThreadKeys,
  firstmateHomeProjectKeys,
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
