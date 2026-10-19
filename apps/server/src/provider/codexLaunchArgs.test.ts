import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexLaunchArgsModelProvider,
  codexLaunchArgsUseCustomModelProvider,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
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
