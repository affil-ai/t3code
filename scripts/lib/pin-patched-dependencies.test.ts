import { assert, it } from "@effect/vitest";

import { pinPatchedStageDependencies } from "./pin-patched-dependencies.ts";

it("pins staged dependencies to their patch version so a newer release cannot orphan the patch", () => {
  assert.deepStrictEqual(
    pinPatchedStageDependencies(
      { "node-pty": "^1.2.0-beta.15", "@scope/pkg": "^2.0.0", effect: "4.0.0" },
      {
        "node-pty@1.2.0-beta.15": "patches/node-pty@1.2.0-beta.15.patch",
        "@scope/pkg@2.1.0": "patches/@scope%2Fpkg@2.1.0.patch",
        "not-staged@1.0.0": "patches/not-staged@1.0.0.patch",
        "@unversioned/pkg": "patches/unversioned.patch",
      },
    ),
    { "node-pty": "1.2.0-beta.15", "@scope/pkg": "2.1.0" },
  );
});
