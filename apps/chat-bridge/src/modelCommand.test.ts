import { assert, it } from "vite-plus/test";

import {
  describeModel,
  type ModelSelection,
  parseModelCommand,
  resolveModelCommand,
} from "./modelCommand.ts";

const opus: ModelSelection = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "medium" }],
};

it("takes the first switch out of the message, anywhere in it", () => {
  assert.deepStrictEqual(parseModelCommand("!sol-high fix the build"), {
    text: "fix the build",
    command: { model: "sol", effort: "high", typed: "!sol-high" },
  });
  assert.deepStrictEqual(parseModelCommand("fix the build !opus please"), {
    text: "fix the build please",
    command: { model: "opus", effort: undefined, typed: "!opus" },
  });
  assert.deepStrictEqual(parseModelCommand("!HIGH"), {
    text: "",
    command: { effort: "high", typed: "!HIGH" },
  });
});

it("leaves unknown words, bad efforts and code alone", () => {
  for (const text of [
    "wow!",
    "!nope do it",
    "!sol-fast go",
    "run `!opus` literally",
    "```\n!opus\n```",
  ]) {
    assert.deepStrictEqual(parseModelCommand(text), { text });
  }
});

it("puts GPT models on Codex and the rest on Claude, each at its own effort", () => {
  assert.deepStrictEqual(resolveModelCommand({ model: "sol", typed: "!sol" }, opus), {
    selection: {
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
  });
  const astra = { instanceId: "codex", model: "gpt-6-astra" };
  assert.deepStrictEqual(resolveModelCommand({ model: "glm", typed: "!glm" }, astra), {
    selection: { instanceId: "claudeAgent", model: "z-ai/glm-5.3" },
  });
  assert.deepStrictEqual(
    resolveModelCommand({ model: "opus", effort: "max", typed: "!opus-max" }, astra),
    { selection: { ...opus, options: [{ id: "effort", value: "max" }] } },
  );
});

it("changes only the effort for an effort alone", () => {
  assert.deepStrictEqual(resolveModelCommand({ effort: "low", typed: "!low" }, opus), {
    selection: { ...opus, options: [{ id: "effort", value: "low" }] },
  });
  const glm = { instanceId: "claudeAgent", model: "z-ai/glm-5.3" };
  assert.deepStrictEqual(resolveModelCommand({ effort: "low", typed: "!low" }, glm), {
    error: "GLM 5.3 has no effort setting.",
  });
  assert.strictEqual(describeModel(opus), "Claude Opus 5.5, medium effort");
});
