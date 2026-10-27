import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";
import { makeStderrDiagnostic, makeTerminationError } from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it("keeps raw bytes across split chunks and non-destructive reads", () => {
    const diagnostic = makeStderrDiagnostic();
    assert.equal(diagnostic.read().byteLength, 0);
    const input = new TextEncoder().encode('password="raw së🔒cret"\n');
    for (const byte of input) diagnostic.append(Uint8Array.of(byte));
    diagnostic.append(Uint8Array.of(0, 0xff, 0xc3));
    const expected = new Uint8Array([...input, 0, 0xff, 0xc3]);
    const snapshot = diagnostic.read();
    assert.deepEqual(snapshot, expected);
    snapshot.fill(0);
    assert.deepEqual(diagnostic.read(), expected);
  });

  it("retains exactly the last 64 KiB for oversized chunks and repeated wraparound", () => {
    const input = new TextEncoder().encode(
      "é🙂 closing pipe\n".repeat(20_000) + "final reason: retry exhausted\n",
    );
    const whole = makeStderrDiagnostic();
    whole.append(input);
    const split = makeStderrDiagnostic();
    for (let offset = 0; offset < input.length; offset += 4_093) {
      split.append(input.subarray(offset, offset + 4_093));
    }
    const expected = input.slice(-64 * 1024);
    assert.deepEqual(whole.read(), expected);
    assert.deepEqual(split.read(), expected);
    split.append("last bytes");
    const suffix = new TextEncoder().encode("last bytes");
    assert.deepEqual(split.read(), new Uint8Array([...expected.slice(suffix.length), ...suffix]));
  });

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
