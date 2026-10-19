import { describe, expect, it } from "vite-plus/test";

import { resolvePrimaryBackendHome } from "./DesktopSharedBackendHome.ts";

describe("resolvePrimaryBackendHome", () => {
  it("uses the shared home when no other backend owns it", () => {
    expect(
      resolvePrimaryBackendHome({
        baseDir: "/home/.t3-vivek",
        sharedHomeDir: "/home/.t3",
        isInUse: () => false,
      }),
    ).toEqual({ t3Home: "/home/.t3", sharedHomeBlocked: false });
  });

  it("falls back to its own home while another backend runs there", () => {
    expect(
      resolvePrimaryBackendHome({
        baseDir: "/home/.t3-vivek",
        sharedHomeDir: "/home/.t3",
        isInUse: () => true,
      }),
    ).toEqual({ t3Home: "/home/.t3-vivek", sharedHomeBlocked: true });
  });

  it("keeps its own home when sharing is off", () => {
    expect(
      resolvePrimaryBackendHome({ baseDir: "/home/.t3-vivek", sharedHomeDir: undefined }),
    ).toEqual({ t3Home: "/home/.t3-vivek", sharedHomeBlocked: false });
  });
});
