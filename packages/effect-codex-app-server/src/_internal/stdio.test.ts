import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";
import { makeStderrDiagnostic, makeTerminationError } from "./stdio.ts";

describe("Codex App Server child process termination", () => {
  it("redacts quoted credentials without losing the diagnostic fields", () => {
    const diagnostic = makeStderrDiagnostic();
    diagnostic.append(
      String.raw`{"password":"p@ssw0rd","clientSecret":"first \" hidden tail","client\"Secret":"escaped-key-secret","reason":"pipe closed"}` +
        "\n",
    );
    diagnostic.append(
      String.raw`{'session_token':'first \' hidden tail','reason':'retry exhausted'}` + "\n",
    );
    diagnostic.append('{"pass\\u0077ord":"unicode-key-secret"}\n');
    diagnostic.append(
      "token=bare-token key=bare-key client_secret=client-value API_KEY=api-value\n",
    );
    diagnostic.append('password="unfinished secret with spaces and a trailing \\');

    assert.equal(
      diagnostic.read(),
      String.raw`{"password":"[REDACTED]","clientSecret":"[REDACTED]","client\"Secret":"[REDACTED]","reason":"pipe closed"}` +
        "\n" +
        "{'session_token':'[REDACTED]','reason':'retry exhausted'}\n" +
        '{"pass\\u0077ord":"[REDACTED]"}\n' +
        "token=[REDACTED] key=[REDACTED] client_secret=[REDACTED] API_KEY=[REDACTED]\n" +
        'password="[REDACTED]"',
    );
  });

  it("redacts headers, URLs and standalone credentials retained after overflow", () => {
    const diagnostic = makeStderrDiagnostic();
    diagnostic.append("old noise\n".repeat(8_000));
    diagnostic.append("authorization: Bearer secret-token\n");
    diagnostic.append("https://user:password@example.test/path?token=secret&other=hidden\n");
    diagnostic.append("eyJheader123.payload.signature\n");
    diagnostic.append("ghp_1234567890abcdef sk-1234567890abcdef\n");
    diagnostic.append(
      "Basic dXNlcjpwYXNz\nProxy-Authorization: Bearer 'quoted header secret'\nreason: pipe closed\n",
    );

    const value = diagnostic.read()!;
    assert.include(value, "[stderr tail truncated]");
    assert.include(value, "authorization: [REDACTED]\n");
    assert.include(
      value,
      "https://[REDACTED]@example.test/path?token=[REDACTED]&other=[REDACTED]\n",
    );
    assert.include(value, "reason: pipe closed\n");
    for (const secret of [
      "secret-token",
      "user:password",
      "token=secret",
      "other=hidden",
      "eyJheader123",
      "ghp_1234567890abcdef",
      "sk-1234567890abcdef",
      "dXNlcjpwYXNz",
      "quoted header secret",
    ]) {
      assert.notInclude(value, secret);
    }
  });

  it("preserves long non-secret tokens and URLs without exposing URL credentials", () => {
    const diagnostic = makeStderrDiagnostic();
    const noise = "x".repeat(30_000);
    const url = "https://" + "part:".repeat(4_000);
    diagnostic.append(`${noise}\n${url}\n1https://user:password@example.test/path\n`);

    assert.equal(diagnostic.read(), `${noise}\n${url}\n1https://[REDACTED]@example.test/path\n`);
  });

  it("keeps redaction context across chunks and non-destructive reads", () => {
    const diagnostic = makeStderrDiagnostic();
    assert.isUndefined(diagnostic.read());
    diagnostic.append('{"clientSec');
    diagnostic.append('ret":"first \\');
    assert.equal(diagnostic.read(), '{"clientSecret":"[REDACTED]"');
    diagnostic.append('" hidden tail');
    assert.equal(diagnostic.read(), '{"clientSecret":"[REDACTED]"');
    diagnostic.append('","reason":"pipe closed"}\n');
    assert.equal(diagnostic.read(), '{"clientSecret":"[REDACTED]","reason":"pipe closed"}\n');

    const bytes = new TextEncoder().encode(
      String.raw`{"password":"së🔒cret \"tail","reason":"pipe closed"}`,
    );
    for (let offset = 0; offset <= bytes.length; offset++) {
      const split = makeStderrDiagnostic();
      split.append(bytes.subarray(0, offset));
      split.read();
      split.append(bytes.subarray(offset));
      assert.equal(split.read(), '{"password":"[REDACTED]","reason":"pipe closed"}');
    }
  });

  it("does not expose quoted secrets when the tail starts inside their value", () => {
    const diagnostic = makeStderrDiagnostic();
    diagnostic.append('{"password":"' + "secret words\n".repeat(6_000) + "\\");
    assert.notInclude(diagnostic.read()!, "secret words");
    diagnostic.append('" escaped secret ' + "more secret words\n".repeat(6_000));
    assert.notInclude(diagnostic.read()!, "secret words");
    diagnostic.append('","reason":"pipe closed"}\n');
    const value = diagnostic.read()!;
    assert.include(value, "[stderr tail truncated]");
    assert.include(value, '"reason":"pipe closed"');
    assert.notInclude(value, "secret words");
    assert.notInclude(value, "escaped secret");

    const closed = makeStderrDiagnostic();
    closed.append(
      "{'clientSecret':'" + "secret words\n".repeat(6_000) + "','reason':'retry exhausted'}\n",
    );
    assert.include(closed.read()!, "'reason':'retry exhausted'");
    assert.notInclude(closed.read()!, "secret words");
  });

  it("finds embedded assignments in large closed and unfinished quoted non-keys", () => {
    for (const closingQuote of ['"', ""]) {
      const diagnostic = makeStderrDiagnostic();
      diagnostic.append(
        '"' +
          String.raw`noise \"`.repeat(20_000) +
          ` password=embedded-secret${closingQuote}\nreason: pipe closed\n`,
      );

      const value = diagnostic.read()!;
      assert.include(value, "[stderr tail truncated]\n");
      assert.isTrue(value.endsWith(`password=[REDACTED]${closingQuote}\nreason: pipe closed\n`));
      assert.notInclude(value, "embedded-secret");
    }
  });

  it("retains a useful UTF-8 tail within the byte cap for large and split chunks", () => {
    const encoder = new TextEncoder();
    const input = encoder.encode(
      "é🙂 closing pipe\n".repeat(5_000) + "final reason: retry exhausted\n",
    );
    const whole = makeStderrDiagnostic();
    whole.append(input);
    const split = makeStderrDiagnostic();
    for (let offset = 0; offset < input.length; offset += 4_093) {
      split.append(input.subarray(offset, offset + 4_093));
    }

    const value = split.read()!;
    assert.equal(value, whole.read());
    assert.isAtMost(encoder.encode(value).length, 64 * 1024);
    assert.isAbove(encoder.encode(value).length, 64 * 1024 - 128);
    assert.notInclude(value, "�");
    assert.include(value, "[stderr tail truncated]\n");
    assert.include(value, "é🙂 closing pipe\n");
    assert.isTrue(value.endsWith("final reason: retry exhausted\n"));
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
