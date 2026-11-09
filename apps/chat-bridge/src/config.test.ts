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
      { channelId: "C1", projectId: "n", match: "[webapp]", worktreeFrom: "dev", note: "Light." },
      { channelId: "C1", projectId: "p" },
    ],
    allowedUserIds: ["U1"],
  });
  assert.deepStrictEqual(config.channelProjects, [
    { channelId: "C1", projectId: "n", match: "[webapp]", worktreeFrom: "dev", note: "Light." },
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

it("uses Socket Mode for Slack unless told to read Office's relay", () => {
  const base = { t3Url: "http://x", channelProjects: [], allowedUserIds: [] };
  assert.strictEqual(parseConfig(base).slack.transport, "socket");
  assert.strictEqual(
    parseConfig({ ...base, slack: { transport: "office-relay" } }).slack.transport,
    "office-relay",
  );
  assert.throws(() => parseConfig({ ...base, slack: { transport: "http" } }), /slack.transport/);
});

it("reads former default models and rejects malformed ones", () => {
  const base = { t3Url: "http://x", channelProjects: [], allowedUserIds: [] };
  const astra = {
    instanceId: "codex",
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "medium" }],
  };
  assert.deepEqual(parseConfig({ ...base, formerModelSelections: [astra] }).formerModelSelections, [
    astra,
  ]);
  for (const bad of [
    astra,
    [{ instanceId: "codex" }],
    [{ ...astra, options: { reasoningEffort: "medium" } }],
    [{ ...astra, options: [null] }],
  ])
    assert.throws(
      () => parseConfig({ ...base, formerModelSelections: bad }),
      /formerModelSelections/,
    );
});
