import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();
const MAX_STDERR_DIAGNOSTIC_BYTES = 64 * 1024;

/** Raw bytes for a private diagnostic file only, never a shared log stream. */
export const makeStderrDiagnostic = () => {
  const buffer = new Uint8Array(MAX_STDERR_DIAGNOSTIC_BYTES);
  let offset = 0;
  let size = 0;

  return {
    append: (chunk: string | Uint8Array) => {
      const bytes = (typeof chunk === "string" ? encoder.encode(chunk) : chunk).subarray(
        -MAX_STDERR_DIAGNOSTIC_BYTES,
      );
      const first = Math.min(bytes.length, buffer.length - offset);
      buffer.set(bytes.subarray(0, first), offset);
      buffer.set(bytes.subarray(first), 0);
      offset = (offset + bytes.length) % buffer.length;
      size = Math.min(size + bytes.length, buffer.length);
    },
    read: () => {
      const tail = new Uint8Array(size);
      const start = (offset - size + buffer.length) % buffer.length;
      const first = Math.min(size, buffer.length - start);
      tail.set(buffer.subarray(start, start + first));
      tail.set(buffer.subarray(0, size - first), first);
      return tail;
    },
  };
};

export const makeChildStdio = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? encoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });

export const makeInMemoryStdio = Effect.fn("makeInMemoryStdio")(function* () {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const output = yield* Queue.unbounded<string>();
  const decoder = new TextDecoder();

  return {
    stdio: Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(input),
      stdout: () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Queue.offer(
            output,
            typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }),
          ),
        ),
      stderr: () => Sink.drain,
    }),
    input,
    output,
  };
});

type ChildProcessTerminationHandle = Pick<
  ChildProcessSpawner.ChildProcessHandle,
  "exitCode" | "pid"
>;

export const makeTerminationError = (
  handle: ChildProcessTerminationHandle,
): Effect.Effect<CodexError.CodexAppServerError> =>
  Effect.match(handle.exitCode, {
    onFailure: (cause) =>
      new CodexError.CodexAppServerTransportError({
        operation: "read-process-exit-status",
        pid: handle.pid,
        cause,
      }),
    onSuccess: (code) => new CodexError.CodexAppServerProcessExitedError({ code, pid: handle.pid }),
  });
