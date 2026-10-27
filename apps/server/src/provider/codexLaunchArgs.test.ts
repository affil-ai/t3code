import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexLaunchArgsModelProvider,
  codexLaunchArgsUseCustomModelProvider,
} from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("codexLaunchArgsModelProvider", () => {
  it("reads a quoted -c override", () => {
    NodeAssert.equal(
      codexLaunchArgsModelProvider(
        '-c model_provider="cliproxy8" -c model_catalog_json="/tmp/models.json"',
      ),
      "cliproxy8",
    );
    NodeAssert.equal(codexLaunchArgsUseCustomModelProvider('-c model_provider="cliproxy8"'), true);
  });

  it("reads --config, -c=, and --config= forms, last one winning", () => {
    NodeAssert.equal(codexLaunchArgsModelProvider("--config model_provider=a"), "a");
    NodeAssert.equal(codexLaunchArgsModelProvider("-c=model_provider='b'"), "b");
    NodeAssert.equal(codexLaunchArgsModelProvider("--config=model_provider=c"), "c");
    NodeAssert.equal(codexLaunchArgsModelProvider("-c model_provider=a -c model_provider=d"), "d");
  });

  it("treats the default provider and unrelated args as ChatGPT", () => {
    NodeAssert.equal(codexLaunchArgsModelProvider("--strict-config -c model=gpt-5"), undefined);
    NodeAssert.equal(codexLaunchArgsUseCustomModelProvider(""), false);
    NodeAssert.equal(codexLaunchArgsUseCustomModelProvider("-c model_provider=openai"), false);
    NodeAssert.equal(codexLaunchArgsUseCustomModelProvider("-c model_provider="), false);
  });
});
