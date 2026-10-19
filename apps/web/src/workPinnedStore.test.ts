import { describe, expect, it } from "vite-plus/test";

import { sanitizePinnedData, togglePinnedThread } from "./workPinnedStore";

describe("workPinnedStore", () => {
  it("pins to the front and unpins", () => {
    let data = togglePinnedThread({ pinnedThreadKeys: [] }, "env:a");
    data = togglePinnedThread(data, "env:b");
    expect(data.pinnedThreadKeys).toEqual(["env:b", "env:a"]);
    expect(togglePinnedThread(data, "env:b").pinnedThreadKeys).toEqual(["env:a"]);
  });

  it("drops invalid and duplicate stored keys", () => {
    expect(sanitizePinnedData({ pinnedThreadKeys: ["env:a", 3, "", "env:a"] })).toEqual({
      pinnedThreadKeys: ["env:a"],
    });
    expect(sanitizePinnedData(null)).toEqual({ pinnedThreadKeys: [] });
  });
});
