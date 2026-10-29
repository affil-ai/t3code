import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as CodexClient from "effect-codex-app-server/client";

import * as ServerConfig from "../config.ts";
import { makeCodexAppServerDiagnosticWriter } from "./CodexAppServerDiagnostics.ts";

const rawStderr = new TextEncoder().encode('password="raw private diagnostic"\n\u0000�');
type DiagnosticWriter = NonNullable<
  CodexClient.CodexAppServerClientOptions["writeStderrDiagnostic"]
>;

const terminate = (
  writeStderrDiagnostic: DiagnosticWriter,
  exitStatusError?: PlatformError.PlatformError,
  onRecovered: Effect.Effect<void> = Effect.void,
  closeOwningScope = false,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1700000000000);
    const messages: unknown[] = [];
    const stderrRead = yield* Deferred.make<void>();
    const requestSent = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const handle = ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(51),
      exitCode: Deferred.await(exited).pipe(
        Effect.filterOrFail(
          () => !exitStatusError,
          () => exitStatusError as PlatformError.PlatformError,
        ),
      ),
      isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
      kill: () => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(9)).pipe(Effect.asVoid),
      unref: Effect.succeed(Effect.void),
      stdin: Sink.forEach((_chunk: Uint8Array) => Deferred.succeed(requestSent, undefined)),
      stdout: Stream.fromEffect(Deferred.await(exited)).pipe(Stream.drain),
      stderr: Stream.succeed(rawStderr).pipe(
        Stream.ensuring(Deferred.succeed(stderrRead, undefined)),
      ),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
    return yield* Effect.gen(function* () {
      const owner = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));
      const diagnosticsScope = closeOwningScope ? yield* Scope.fork(owner) : undefined;
      if (closeOwningScope) {
        // Match production: process acquisition precedes the client layer.
        yield* Effect.acquireRelease(Effect.succeed(handle), (child) =>
          child.kill().pipe(Effect.ignore),
        ).pipe(Scope.provide(owner));
      }
      const context = yield* Layer.build(
        CodexClient.layerChildProcess(handle, {
          writeStderrDiagnostic,
          ...(diagnosticsScope === undefined ? {} : { diagnosticsScope }),
        }),
      ).pipe(Scope.provide(owner));
      const client = yield* CodexClient.CodexAppServerClient.pipe(Effect.provide(context));
      const pending = yield* client.raw
        .request("test/pending", {})
        .pipe(Effect.result, Effect.forkScoped);
      yield* Deferred.await(stderrRead);
      yield* Deferred.await(requestSent);
      const closing = closeOwningScope
        ? yield* Scope.close(owner, Exit.void).pipe(Effect.forkScoped)
        : undefined;
      if (!closeOwningScope) {
        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(9));
        const error = yield* client.terminated;
        const result = yield* Fiber.join(pending);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) assert.strictEqual(result.failure, error);
        assert.equal(
          error._tag,
          exitStatusError ? "CodexAppServerTransportError" : "CodexAppServerProcessExitedError",
        );
      } else {
        const result = yield* Fiber.join(pending);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.equal(result.failure._tag, "CodexAppServerInputStreamEndedError");
        }
      }
      yield* onRecovered;
      if (closing) yield* Fiber.join(closing);
      return messages;
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Logger.layer([Logger.make(({ message }) => messages.push(message))], {
          mergeWithExisting: false,
        }),
      ),
    );
  });

it.layer(NodeServices.layer)("Codex app-server private diagnostics", (it) => {
  const withConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-codex-diagnostics-" });

  it.effect("writes raw stderr privately and logs only termination metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const directory = path.join(config.logsDir, "codex-app-server");
      const write = yield* makeCodexAppServerDiagnosticWriter;
      const messages = yield* terminate(write);
      const files = yield* fs.readDirectory(directory);
      assert.equal(files.length, 1);
      assert.match(files[0]!, /^\d{13}-51\.stderr$/);
      const diagnosticPath = path.join(directory, files[0]!);
      assert.deepEqual(yield* fs.readFile(diagnosticPath), rawStderr);
      assert.equal((yield* fs.stat(diagnosticPath)).mode & 0o777, 0o600);
      assert.equal((yield* fs.stat(directory)).mode & 0o777, 0o700);
      assert.deepEqual(messages, [
        [
          "Codex app-server terminated",
          { code: 9, stderrBytes: rawStderr.byteLength, diagnosticPath },
        ],
      ]);
      assert.notInclude(JSON.stringify(messages), "raw private diagnostic");
    }).pipe(Effect.provide(withConfig)),
  );

  it.effect("keeps only the newest 20 diagnostics without overwriting existing files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const directory = path.join(config.logsDir, "codex-app-server");
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o755 });
      for (let index = 0; index < 22; index++) {
        yield* fs.writeFileString(path.join(directory, `${1000000000000 + index}-1.stderr`), "old");
      }
      yield* fs.writeFileString(path.join(directory, "unrelated.txt"), "leave alone");
      const write = yield* makeCodexAppServerDiagnosticWriter;
      yield* TestClock.setTime(1700000000000);
      const diagnosticPath = yield* write(51, rawStderr);
      assert.isDefined(diagnosticPath);
      const files = yield* fs.readDirectory(directory);
      assert.equal(files.length, 21);
      assert.include(files, path.basename(diagnosticPath));
      assert.include(files, "1000000000021-1.stderr");
      assert.include(files, "1000000000003-1.stderr");
      assert.notInclude(files, "1000000000002-1.stderr");
      assert.equal(yield* fs.readFileString(path.join(directory, "unrelated.txt")), "leave alone");
      assert.equal((yield* fs.stat(directory)).mode & 0o777, 0o700);
      // Reusing the same timestamp and pid must fail rather than truncate.
      const collision = yield* write(51, new TextEncoder().encode("replacement"));
      assert.isUndefined(collision);
      assert.deepEqual(yield* fs.readFile(diagnosticPath), rawStderr);
    }).pipe(Effect.provide(withConfig)),
  );

  it.effect("recovers pending RPCs when the diagnostic directory cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.writeFileString(path.join(config.logsDir, "codex-app-server"), "not a directory");
      const write = yield* makeCodexAppServerDiagnosticWriter;
      const messages = yield* terminate(write);
      assert.deepEqual(messages, [
        [
          "Codex app-server terminated",
          { code: 9, stderrBytes: rawStderr.byteLength, diagnosticPath: undefined },
        ],
      ]);
    }).pipe(Effect.provide(withConfig)),
  );
});

describe("Codex app-server diagnostic writer failures", () => {
  it.effect.each([false, true])(
    "bounds a stalled diagnostic write without blocking pending RPC closure (scope close: %s)",
    (closeOwningScope) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const recovered = yield* Deferred.make<void>();
        const pending = yield* terminate(
          () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          undefined,
          Deferred.succeed(recovered, undefined).pipe(Effect.asVoid),
          closeOwningScope,
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        // Pending RPCs close before the diagnostic timeout, not after it.
        yield* Deferred.await(recovered);
        yield* TestClock.adjust("1 second");
        const messages = yield* Fiber.join(pending);
        assert.deepEqual(messages, [
          [
            "Codex app-server terminated",
            { code: 9, stderrBytes: rawStderr.byteLength, diagnosticPath: undefined },
          ],
        ]);
      }),
  );

  it.effect("logs only the signal for a platform signal exit, not its error or stderr", () =>
    Effect.gen(function* () {
      const messages = yield* terminate(
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - The diagnostic writer returns string | undefined, not the wider void type.
        () => Effect.succeed(undefined),
        PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "exitCode",
          pathOrDescriptor: "private command details",
          cause: new Error("Process interrupted due to receipt of signal: 'SIGKILL'"),
        }),
      );
      assert.deepEqual(messages, [
        [
          "Codex app-server terminated",
          {
            code: undefined,
            signal: "SIGKILL",
            stderrBytes: rawStderr.byteLength,
            diagnosticPath: undefined,
          },
        ],
      ]);
    }),
  );

  it.effect.each([
    { name: "defect", writer: () => Effect.die(rawStderr) },
    { name: "scope-close defect", writer: () => Effect.die(rawStderr), closeOwningScope: true },
    {
      name: "scope-close synchronous throw",
      writer: () => {
        throw rawStderr;
      },
      closeOwningScope: true,
    },
    {
      name: "synchronous throw",
      writer: () => {
        throw rawStderr;
      },
    },
  ] satisfies Array<{ name: string; writer: DiagnosticWriter; closeOwningScope?: boolean }>)(
    "does not leak stderr or block recovery on $name",
    ({ writer, closeOwningScope }) =>
      Effect.gen(function* () {
        const messages = yield* terminate(writer, undefined, Effect.void, closeOwningScope);
        assert.deepEqual(messages, [
          [
            "Codex app-server terminated",
            { code: 9, stderrBytes: rawStderr.byteLength, diagnosticPath: undefined },
          ],
        ]);
      }),
  );
});
