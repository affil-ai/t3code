import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";
import { makeStderrDiagnostic, makeTerminationError } from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it("keeps a bounded redacted stderr tail across chunks", () => {
    const diagnostic = makeStderrDiagnostic();
    diagnostic.append("authorization: Bearer secret-token\n");
    diagnostic.append("https://user:password@example.test/path?token=secret\n");
    diagnostic.append("eyJheader.payload.signature\n");
    diagnostic.append("x".repeat(70_000));

    const value = diagnostic.read();
    assert.isDefined(value);
    assert.isAtMost(new TextEncoder().encode(value!).length, 64 * 1024);
    assert.notInclude(value!, "secret-token");
    assert.notInclude(value!, "password@example");
    assert.notInclude(value!, "token=secret");
    assert.notInclude(value!, "eyJheader");
    assert.include(value!, "[stderr tail truncated]");
  });

  it.effect("retains the process identifier with the exit code", () =>
    Effect.gen(function* () {
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(51),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(9)),
      });

      assert.instanceOf(error, CodexError.CodexAppServerProcessExitedError);
      assert.equal(error.pid, 51);
      assert.equal(error.code, 9);
      assert.equal(error.message, "Codex App Server process exited with code 9");
    }),
  );

  it.effect("retains the process identifier and exact exit-status cause", () =>
    Effect.gen(function* () {
      const rootCause = new Error("private process diagnostics");
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        cause: rootCause,
      });
      const error = yield* makeTerminationError({
        pid: ChildProcessSpawner.ProcessId(52),
        exitCode: Effect.fail(cause),
      });

      assert.instanceOf(error, CodexError.CodexAppServerTransportError);
      assert.equal(error.pid, 52);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Codex App Server transport operation 'read-process-exit-status' failed.",
      );
      assert.notInclude(error.message, rootCause.message);
    }),
  );
});
