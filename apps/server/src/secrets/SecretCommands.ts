/**
 * SecretCommands - runs a command an agent wrote with secrets the user
 * entered, so the agent can use a secret anywhere a shell can (an API call,
 * a CLI login, a private file) without seeing it.
 *
 * Values reach the command through its environment, standard input, or a
 * private file, never its command line. What the command prints comes back
 * with every value and its common encodings redacted, and that redacted text
 * is all that reaches the agent, its transcript, or the logs.
 *
 * @module SecretCommands
 */
import {
  OrchestratorMcpFailure,
  RUN_WITH_SECRET_DEFAULT_TIMEOUT_MS,
  type OrchestratorMcpRunWithSecretInput,
  type OrchestratorMcpRunWithSecretResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerConfig from "../config.ts";
import { makeSecretRedactor } from "./redactSecrets.ts";
import * as SecretRequests from "./SecretRequests.ts";

/** Inherited variables a command must not get, as for the integrated terminal. */
const ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
/**
 * Delivery names that would let a secret change how the shell or a loader
 * runs, e.g. a file in BASH_ENV is run as code.
 */
const RESERVED_NAME =
  /^(PATH|HOME|SHELL|IFS|ENV|BASH_ENV|BASH_FUNC_.*|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|CDPATH|GLOBIGNORE|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|LD_.*|DYLD_.*)$/i;
/** How long a command that ignores the stop signal gets before it is killed. */
const FORCE_KILL_AFTER = Duration.seconds(5);

/** Kept from each stream before redaction; the rest is drained and dropped. */
const MAX_CAPTURED_BYTES = 1024 * 1024;
/** Returned from each stream after redaction. */
const MAX_RETURNED_CHARS = 64 * 1024;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** The platform shell a command string runs in. */
const shellInvocation = (platform: NodeJS.Platform, command: string) =>
  platform === "win32"
    ? {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
      }
    : { command: "bash", args: ["-c", command] };

export class SecretCommands extends Context.Service<
  SecretCommands,
  {
    /**
     * Runs `command` for `threadId` with the secrets it names, in that
     * thread's workspace unless `cwd` says otherwise.
     */
    readonly run: (
      input: OrchestratorMcpRunWithSecretInput & { readonly threadId: ThreadId },
    ) => Effect.Effect<OrchestratorMcpRunWithSecretResult, OrchestratorMcpFailure>;
  }
>()("t3/secrets/SecretCommands") {}

const make = Effect.gen(function* () {
  const secretRequests = yield* SecretRequests.SecretRequests;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  // Private files live under the T3 home, not the shared temp directory, so a
  // run a crash interrupted leaves nothing behind past the next start.
  const runsDirectory = path.join(config.stateDir, "secret-runs");
  yield* fileSystem.remove(runsDirectory, { recursive: true, force: true }).pipe(Effect.orDie);
  yield* fileSystem
    .makeDirectory(runsDirectory, { recursive: true, mode: 0o700 })
    .pipe(Effect.andThen(fileSystem.chmod(runsDirectory, 0o700)), Effect.orDie);

  /** The thread's worktree, else its project's root. */
  const workspaceOf = Effect.fn("SecretCommands.workspaceOf")(function* (threadId: ThreadId) {
    const thread = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => failure("orchestration_error", "Could not read the thread.")));
    if (thread === null) return yield* failure("thread_not_found", "The thread was not found.");
    if (thread.worktreePath !== null) return thread.worktreePath;
    const project = yield* projects
      .getById(thread.projectId)
      .pipe(Effect.mapError(() => failure("orchestration_error", "Could not read the project.")));
    if (Option.isNone(project)) {
      return yield* failure("orchestration_error", "The thread's project was not found.");
    }
    return project.value.workspaceRoot;
  });

  const resolveCwd = Effect.fn("SecretCommands.resolveCwd")(function* (
    threadId: ThreadId,
    cwd: string | undefined,
  ) {
    const resolved = path.resolve(yield* workspaceOf(threadId), cwd ?? ".");
    const info = yield* fileSystem.stat(resolved).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") {
      return yield* failure("invalid_request", `cwd ${resolved} is not a directory.`);
    }
    return resolved;
  });

  /** Each secret's delivery, checked before any value is read. */
  const checkDeliveries = Effect.fn("SecretCommands.checkDeliveries")(function* (
    secrets: OrchestratorMcpRunWithSecretInput["secrets"],
  ) {
    const deliveries = secrets.map((secret) => ({ ...secret, as: secret.as ?? "env" }));
    if (deliveries.filter((delivery) => delivery.as === "stdin").length > 1) {
      return yield* failure("invalid_request", "Only one secret can be delivered on stdin.");
    }
    const names = new Set<string>();
    for (const delivery of deliveries) {
      if (delivery.as === "stdin") continue;
      if (delivery.name === undefined) {
        return yield* failure(
          "invalid_request",
          `A secret delivered as ${delivery.as} needs a name for its environment variable.`,
        );
      }
      if (RESERVED_NAME.test(delivery.name)) {
        return yield* failure(
          "invalid_request",
          `${delivery.name} changes how commands run; choose another name.`,
        );
      }
      if (names.has(delivery.name)) {
        return yield* failure("invalid_request", `${delivery.name} is used twice.`);
      }
      names.add(delivery.name);
    }
    return deliveries;
  });

  const run: SecretCommands["Service"]["run"] = Effect.fn("SecretCommands.run")(
    function* (input) {
      const deliveries = yield* checkDeliveries(input.secrets);
      const cwd = yield* resolveCwd(input.threadId, input.cwd);
      const values = yield* Effect.forEach(deliveries, (delivery) =>
        secretRequests
          .use({ ref: delivery.secretRef, threadId: input.threadId })
          .pipe(Effect.mapError((error) => failure("invalid_request", error.message))),
      );
      const redactor = makeSecretRedactor(values);

      const env: Record<string, string> = {};
      let stdin = "";
      const needsFiles = deliveries.some((delivery) => delivery.as === "file");
      // A private directory per run, removed with everything in it when the
      // command ends, however it ends.
      const directory = needsFiles
        ? yield* fileSystem
            .makeTempDirectoryScoped({ directory: runsDirectory, prefix: "run-" })
            .pipe(
              Effect.tap((created) => fileSystem.chmod(created, 0o700)),
              Effect.mapError(() =>
                failure("orchestration_error", "Could not create a private directory."),
              ),
            )
        : undefined;
      for (const [index, delivery] of deliveries.entries()) {
        const value = values[index]!;
        if (delivery.as === "stdin") {
          stdin = value;
        } else if (delivery.as === "env") {
          env[delivery.name!] = value;
        } else {
          const file = path.join(directory!, delivery.name!);
          yield* fileSystem
            .writeFileString(file, value, { flag: "wx", mode: 0o600 })
            .pipe(
              Effect.mapError(() =>
                failure("orchestration_error", "Could not write the secret file."),
              ),
            );
          env[delivery.name!] = file;
        }
      }

      const timeoutMs = input.timeoutMs ?? RUN_WITH_SECRET_DEFAULT_TIMEOUT_MS;
      const shell = shellInvocation(yield* HostProcess.Platform, input.command);
      const output = yield* processRunner
        .run({
          ...shell,
          cwd,
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(([name]) => !ENV_BLOCKLIST.has(name)),
            ),
            ...env,
          },
          extendEnv: false,
          forceKillAfter: FORCE_KILL_AFTER,
          // Always written, even empty, so a command reading stdin sees its end.
          stdin,
          stdinMayBeUnread: true,
          timeout: Duration.millis(timeoutMs),
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: MAX_CAPTURED_BYTES,
          outputMode: "truncate",
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Could not run the command: ${redactor.redact(error.message).text}`,
            ),
          ),
        );

      let redactions = 0;
      let outputTruncated = false;
      const finish = (text: string, captureTruncated: boolean) => {
        // A cut can end partway through a value, where it no longer matches;
        // dropping what could be such a prefix keeps it out.
        const whole = captureTruncated
          ? text.slice(0, Math.max(0, text.length - redactor.longestVariant))
          : text;
        const redacted = redactor.redact(whole);
        redactions += redacted.count;
        const truncated = captureTruncated || redacted.text.length > MAX_RETURNED_CHARS;
        outputTruncated ||= truncated;
        return truncated
          ? `${redacted.text.slice(0, MAX_RETURNED_CHARS)}\n[output truncated]`
          : redacted.text;
      };
      const stdout = finish(output.stdout, output.stdoutTruncated);
      const stderr = finish(output.stderr, output.stderrTruncated);
      const exitCode = output.code === null ? null : Number(output.code);

      yield* Effect.annotateCurrentSpan({
        "secret_command.secrets": deliveries.length,
        "secret_command.exit_code": exitCode ?? -1,
        "secret_command.timed_out": output.timedOut,
        "secret_command.redactions": redactions,
      });
      yield* Metrics.increment(Metrics.secretCommandsTotal, {
        result: output.timedOut ? "timed_out" : exitCode === 0 ? "succeeded" : "failed",
      });
      return {
        exitCode,
        timedOut: output.timedOut,
        stdout,
        stderr,
        outputTruncated,
        redactions,
      };
    },
    Effect.scoped,
  );

  return SecretCommands.of({ run });
});

export const layer = Layer.effect(SecretCommands, make);
