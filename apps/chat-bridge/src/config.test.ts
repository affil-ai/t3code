import { assert, it } from "vite-plus/test";

import { DEFAULT_TOOLS_PORT, parseConfig } from "./config.ts";

it("fills defaults and rejects a bad config", () => {
  const config = parseConfig({
    t3Url: "http://127.0.0.1:3773",
    t3EnvironmentId: "shared-environment",
    channelProjects: [{ channelId: "C1", projectId: "p" }],
    allowedUserIds: ["U1"],
  });
  assert.strictEqual(config.toolsPort, DEFAULT_TOOLS_PORT);
  assert.strictEqual(config.t3EnvironmentId, "shared-environment");
  assert.throws(
    () =>
      parseConfig({
        t3Url: "http://localhost",
        channelProjects: [],
        allowedUserIds: [],
        t3EnvironmentId: "",
      }),
    /t3EnvironmentId/,
  );
  assert.isFalse(config.allowEveryone, "the allowlist is the default");
  assert.isFalse(config.startTools, "slack_start and linear_start are off unless enabled");
  assert.throws(
    () =>
      parseConfig({ t3Url: "http://x", channelProjects: [], allowedUserIds: [], startTools: 1 }),
    /startTools/,
  );
  assert.throws(
    () =>
      parseConfig({
        t3Url: "http://x",
        channelProjects: [],
        allowedUserIds: [],
        allowEveryone: "yes",
      }),
    /allowEveryone/,
  );
  assert.throws(() => parseConfig({ channelProjects: [], allowedUserIds: [] }), /t3Url/);
  assert.throws(
    () =>
      parseConfig({
        t3Url: "http://x",
        channelProjects: [],
        allowedUserIds: [],
        followUpMode: "queue",
      }),
    /followUpMode/,
  );
});

it("reads channel routes with a match, a worktree branch and a note", () => {
  const config = parseConfig({
    t3Url: "http://127.0.0.1:3773",
    channelProjects: [
      { channelId: "C1", projectId: "n", match: "[nextcard]", worktreeFrom: "dev", note: "Light." },
      { channelId: "C1", projectId: "p" },
    ],
    allowedUserIds: ["U1"],
  });
  assert.deepStrictEqual(config.channelProjects, [
    { channelId: "C1", projectId: "n", match: "[nextcard]", worktreeFrom: "dev", note: "Light." },
    { channelId: "C1", projectId: "p" },
  ]);
  assert.throws(
    () =>
      parseConfig({
        t3Url: "http://x",
        channelProjects: [{ channelId: "C1", projectId: "p", match: "" }],
        allowedUserIds: [],
      }),
    /match/,
  );
});
