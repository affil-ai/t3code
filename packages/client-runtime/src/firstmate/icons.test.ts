import { FIRSTMATE_DEFAULT_ICON } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { FIRSTMATE_ICON_KEYS, resolveFirstmateIconKey } from "./icons.ts";

describe("resolveFirstmateIconKey", () => {
  it("defaults to the compass, which is in the picker", () => {
    expect(FIRSTMATE_DEFAULT_ICON).toBe("compass");
    expect(FIRSTMATE_ICON_KEYS).toContain(FIRSTMATE_DEFAULT_ICON);
    expect(resolveFirstmateIconKey(undefined)).toBe("compass");
    expect(resolveFirstmateIconKey(null)).toBe("compass");
  });

  it("keeps every icon the picker offers", () => {
    expect(FIRSTMATE_ICON_KEYS).toHaveLength(24);
    for (const key of FIRSTMATE_ICON_KEYS) expect(resolveFirstmateIconKey(key)).toBe(key);
  });

  it("draws an unknown or inherited key as the compass", () => {
    expect(resolveFirstmateIconKey("future-icon")).toBe("compass");
    expect(resolveFirstmateIconKey("toString")).toBe("compass");
    expect(resolveFirstmateIconKey("")).toBe("compass");
  });
});
