import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as BootService from "../cloud/bootService.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

/**
 * Set only by a supervisor that runs outside T3, such as the fork release's
 * detached `systemd-run` unit, to stop or replace the service on purpose.
 */
export const DETACHED_SERVICE_UPDATE_ENV = "T3_DETACHED_SERVICE_UPDATE";

const DETACHED_HANDOFF = "node scripts/fork-release/handoff.mjs start-linux VERSION";

export class ManagedProcessTreeError extends Schema.TaggedError<ManagedProcessTreeError>()(
  "ManagedProcessTreeError",
  { action: Schema.String, evidence: Schema.String },
) {
  override get message(): string {
    return [
      `Refusing to ${this.action} the T3 background service from inside a T3-managed process (${this.evidence}).`,
      "Stopping the server stops this command with it, and the server stays down.",
      `Run the update from a detached unit instead: \`${DETACHED_HANDOFF}\` in the Affil fork, or a terminal T3 does not own.`,
    ].join("\n  ");
  }
}

/** True when a `/proc/<pid>/cgroup` document places the process in a T3 provider scope. */
export function isT3ProviderCgroup(cgroup: string): boolean {
  return cgroup.split("\n").some((line) =>
    line
      .split(":")
      .slice(2)
      .join(":")
      .split("/")
      .some((segment) => /^t3code-.+\.scope$/.test(segment)),
  );
}

/** Parent pid from `/proc/<pid>/stat`. The command name can contain spaces and parentheses. */
export function parentPidFromStat(stat: string): number | undefined {
  const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : undefined;
}

/**
 * Fails when this process would die with the server it is about to stop: it
 * runs in a T3 provider scope, or descends from the live `serve` process.
 */
export const assertOutsideManagedProcessTree = Effect.fn("cli.managed_process_tree.assert_outside")(
  function* (action: string, serverRuntimeStatePath: string) {
    if ((yield* HostProcess.Platform) !== "linux") return;
    if ((yield* HostProcess.Environment)[DETACHED_SERVICE_UPDATE_ENV] === "1") return;
    const fs = yield* FileSystem.FileSystem;
    const read = (file: string) => fs.readFileString(file).pipe(Effect.option);

    const cgroup = yield* read("/proc/self/cgroup");
    if (Option.isSome(cgroup) && isT3ProviderCgroup(cgroup.value)) {
      return yield* new ManagedProcessTreeError({
        action,
        evidence: "cgroup is a t3code-*.scope",
      });
    }

    const server = yield* readPersistedServerRuntimeState(serverRuntimeStatePath).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(server)) return;
    let pid = Option.flatMap(yield* read("/proc/self/stat"), (stat) =>
      Option.fromUndefinedOr(parentPidFromStat(stat)),
    );
    for (let depth = 0; depth < 64 && Option.isSome(pid) && pid.value > 1; depth++) {
      if (pid.value === server.value.pid) {
        return yield* new ManagedProcessTreeError({
          action,
          evidence: `descends from the running server, pid ${server.value.pid}`,
        });
      }
      pid = Option.flatMap(yield* read(`/proc/${pid.value}/stat`), (stat) =>
        Option.fromUndefinedOr(parentPidFromStat(stat)),
      );
    }
  },
);

/**
 * Wraps a `t3 service` command. When `stops` names what it does to an installed
 * service, the command refuses from inside T3 before touching anything.
 */
export function guardServiceStop<A, E>(
  stops: string | undefined,
  serverRuntimeStatePath: string,
  run: Effect.Effect<A, E, BootService.BootService>,
) {
  if (stops === undefined) return run;
  return Effect.gen(function* () {
    if ((yield* (yield* BootService.BootService).status).installed) {
      yield* assertOutsideManagedProcessTree(stops, serverRuntimeStatePath);
    }
    return yield* run;
  });
}
