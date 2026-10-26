import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  assertOutsideManagedProcessTree,
  DETACHED_SERVICE_UPDATE_ENV,
  isT3ProviderCgroup,
  parentPidFromStat,
} from "./managedProcessTree.ts";

it("recognizes T3 provider scopes and nothing else", () => {
  assert.isTrue(
    isT3ProviderCgroup(
      "0::/user.slice/user-1003.slice/user@1003.service/app.slice/app-t3code.slice/app-t3code-agents.slice/app-t3code-agents-975545b7a0c8.slice/t3code-claude-088eb43f.scope\n",
    ),
  );
  assert.isTrue(isT3ProviderCgroup("0::/app.slice/t3code-codex-1a2b.scope"));
  for (const cgroup of [
    "0::/user.slice/user-1003.slice/user@1003.service/app.slice/t3code.service",
    "0::/user.slice/user-1003.slice/user@1003.service/app.slice/t3-fork-release.service",
    "0::/user.slice/user-1003.slice/session-4.scope",
    "",
  ]) {
    assert.isFalse(isT3ProviderCgroup(cgroup), cgroup);
  }
});

it("reads the parent pid even when the command name has spaces and parentheses", () => {
  assert.equal(parentPidFromStat("4242 (node) S 17 4242 17 0 -1"), 17);
  assert.equal(parentPidFromStat("4242 (t3 (serve) x) S 99 4242 17 0 -1"), 99);
  assert.isUndefined(parentPidFromStat("garbage"));
});

it.layer(NodeServices.layer)("updating the service from inside T3", (it) => {
  const writeServerState = (pid: number) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-managed-tree-" });
      const statePath = path.join(root, "server-runtime.json");
      yield* fs.writeFileString(
        statePath,
        JSON.stringify({
          version: 1,
          pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "1970-01-01T00:00:00.000Z",
          serviceManaged: true,
        }),
      );
      return statePath;
    });

  it.effect("refuses a descendant of the running server unless a detached unit opts in", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux") return;
      const fs = yield* FileSystem.FileSystem;
      // Our parent stands in for the live `serve` process.
      const parent = parentPidFromStat(yield* fs.readFileString("/proc/self/stat"));
      assert.isDefined(parent);
      const serverRuntimeStatePath = yield* writeServerState(parent!);
      const environment = { ...(yield* HostProcess.Environment) };
      delete environment[DETACHED_SERVICE_UPDATE_ENV];

      const refused = yield* assertOutsideManagedProcessTree("update", serverRuntimeStatePath).pipe(
        Effect.provideService(HostProcess.Environment, environment),
        Effect.flip,
      );
      assert.include(refused.message, "handoff.mjs start-linux VERSION");

      yield* assertOutsideManagedProcessTree("update", serverRuntimeStatePath).pipe(
        Effect.provideService(HostProcess.Environment, {
          ...environment,
          [DETACHED_SERVICE_UPDATE_ENV]: "1",
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("allows an update when this process is unrelated to the server", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux") return;
      const fs = yield* FileSystem.FileSystem;
      if (isT3ProviderCgroup(yield* fs.readFileString("/proc/self/cgroup"))) return;
      // pid 1 is never an ancestor the walk compares against.
      const serverRuntimeStatePath = yield* writeServerState(1);
      yield* assertOutsideManagedProcessTree("update", serverRuntimeStatePath);
    }).pipe(Effect.scoped),
  );
});
