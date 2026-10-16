import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as CodexError from "../errors.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_STDERR_DIAGNOSTIC_BYTES = 64 * 1024;
const STDERR_TRUNCATION_MARKER = "[stderr tail truncated]\n";

/**
 * Keeps only the bounded tail of child stderr. The complete retained byte tail
 * is redacted at read time, so credentials split across chunks are handled as
 * one value rather than as independent fragments.
 */
export interface StderrDiagnostic {
  readonly append: (chunk: string | Uint8Array) => void;
  readonly read: () => string | undefined;
}

const redactStderr = (value: string): string => {
  let redacted = value;
  // Header and key/value forms are handled before standalone token patterns.
  redacted = redacted.replace(
    /((?:authorization|proxy-authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|password|secret|credential)\s*[:=]\s*)(?:(?:bearer|basic)\s+)?[^\s,;}"]+/gi,
    "$1[REDACTED]",
  );
  // URL credentials and query values are never useful in a termination tail.
  redacted = redacted.replace(
    /([a-z][a-z\d+.-]*:\/\/)(?:[^\s/@]+(?::[^\s/@]*)?@)/gi,
    "$1[REDACTED]@",
  );
  redacted = redacted.replace(/([?&][a-z\d_.~-]+)=([^&#\s]+)/gi, "$1[REDACTED]");
  // Common bearer/basic formats, JWTs, and recognizable provider credentials.
  redacted = redacted.replace(
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    (match) => `${match.slice(0, match.indexOf(" ") + 1)}[REDACTED]`,
  );
  redacted = redacted.replace(
    /\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
    "[REDACTED]",
  );
  redacted = redacted.replace(
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,})\b/g,
    "[REDACTED]",
  );
  return redacted;
};

const boundedUtf8 = (value: string, truncated: boolean): string => {
  let body = redactStderr(value);
  // A retained tail can begin in the middle of a token whose first bytes were
  // discarded. Mask that leading fragment rather than trusting a partial match.
  if (truncated && body.length > 0 && !/^\s/.test(body)) {
    const end = body.search(/\s/);
    body = `[REDACTED]${end === -1 ? "" : body.slice(end)}`;
  }
  const marker = truncated ? STDERR_TRUNCATION_MARKER : "";
  const markerBytes = encoder.encode(marker);
  const bodyBytes = encoder.encode(body);
  if (markerBytes.length + bodyBytes.length <= MAX_STDERR_DIAGNOSTIC_BYTES) {
    return `${marker}${body}`;
  }
  const available = Math.max(0, MAX_STDERR_DIAGNOSTIC_BYTES - markerBytes.length);
  return `${marker}${decoder.decode(bodyBytes.slice(-available))}`;
};

export const makeStderrDiagnostic = (): StderrDiagnostic => {
  let tail = new Uint8Array(0);
  let truncated = false;

  return {
    append: (chunk) => {
      const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      if (bytes.length === 0) return;
      if (bytes.length >= MAX_STDERR_DIAGNOSTIC_BYTES) {
        tail = bytes.slice(-MAX_STDERR_DIAGNOSTIC_BYTES);
        truncated = true;
        return;
      }
      const retained = Math.min(MAX_STDERR_DIAGNOSTIC_BYTES, tail.length + bytes.length);
      const next = new Uint8Array(retained);
      const tailStart = Math.max(0, tail.length - (retained - bytes.length));
      next.set(tail.slice(tailStart), 0);
      next.set(bytes, retained - bytes.length);
      truncated = truncated || tailStart > 0;
      tail = next;
    },
    read: () => {
      if (tail.length === 0) return undefined;
      return boundedUtf8(decoder.decode(tail), truncated);
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
