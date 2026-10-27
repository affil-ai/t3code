import { describe, expect, it } from "vite-plus/test";

import {
  resolveEnvironmentIdentificationPillLabel,
  resolveForkStageLabel,
  resolveSidebarStageBackdropVariant,
} from "./SidebarStageBackdrop";

// fork: T3 Work drops the Nightly stage art and pill.
describe("SidebarStageBackdrop", () => {
  it("drops the Nightly stage for T3 Work and keeps Dev", () => {
    expect(resolveForkStageLabel("Nightly")).toBe("Alpha");
    expect(resolveSidebarStageBackdropVariant(resolveForkStageLabel("Nightly"))).toBeNull();
    expect(resolveEnvironmentIdentificationPillLabel(resolveForkStageLabel("nightly"))).toBeNull();
    expect(resolveForkStageLabel("Dev")).toBe("Dev");
  });
});
