import { assert, it } from "vite-plus/test";

import { DEFAULT_TOOLS_PORT, parseConfig } from "./config.ts";

it("fills defaults and rejects a bad config", () => {
  const config = parseConfig({
    t3Url: "http://127.0.0.1:3773",
    channelProjects: [{ channelId: "C1", projectId: "p" }],
    allowedUserIds: ["U1"],
  });
  assert.strictEqual(config.followUpMode, "steer");
  assert.strictEqual(config.toolsPort, DEFAULT_TOOLS_PORT);
  assert.throws(() => parseConfig({ channelProjects: [], allowedUserIds: [] }), /t3Url/);
  assert.throws(
    () =>
      parseConfig({
        t3Url: "http://x",
        channelProjects: [],
        allowedUserIds: [],
        followUpMode: "x",
      }),
    /followUpMode/,
  );
});
