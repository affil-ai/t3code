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

/** Keeps a bounded stderr tail, redacting credentials across chunk and tail boundaries. */
export interface StderrDiagnostic {
  readonly append: (chunk: string | Uint8Array) => void;
  readonly read: () => string | undefined;
}

const stderrSecret = (value: string, start: number, valueStart: number) => {
  const scheme = /^(?:bearer|basic)\s+/i.exec(value.slice(valueStart));
  const contentStart = valueStart + (scheme?.[0].length ?? 0);
  const quote =
    value[contentStart] === '"' || value[contentStart] === "'" ? value[contentStart] : "";
  let end = contentStart;
  let closed = false;
  let escaped = false;
  if (quote) {
    for (end = contentStart + 1; end < value.length; end++) {
      if (escaped) escaped = false;
      else if (value[end] === "\\") escaped = true;
      else if (value[end] === quote) {
        end++;
        closed = true;
        break;
      }
    }
  } else {
    end += /^[^\s,;}&"']*/.exec(value.slice(contentStart))![0].length;
  }
  return { start, valueStart, end, quote, open: !closed && end === value.length, escaped };
};

function* stderrSecrets(value: string) {
  const assignments = /("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[\w.-]+)\s*[:=]\s*/g;
  for (let match; (match = assignments.exec(value)) !== null;) {
    const key = match[1]!
      .replace(/\\u([\da-f]{4})|\\([\s\S])/gi, (_, hex: string | undefined, char: string) =>
        hex === undefined ? char : String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/[^a-z\d]/gi, "");
    if (!/(?:authorization|password|secret|credential|token|key)$/i.test(key)) continue;

    const secret = stderrSecret(value, match.index, assignments.lastIndex);
    assignments.lastIndex = Math.max(secret.end, assignments.lastIndex + 1);
    yield secret;
  }
  for (const match of value.matchAll(/\b(?:Bearer|Basic)\s+/gi)) {
    yield stderrSecret(value, match.index, match.index + match[0].length);
  }
}

const redactStderr = (value: string): string => {
  // Outer quoted values cover credential-looking text inside them, including
  // incomplete values at EOF. Always slice the original text, not replacements.
  const secrets = [...stderrSecrets(value)].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const secret of secrets) {
    if (secret.start < cursor) continue;
    parts.push(value.slice(cursor, secret.valueStart), `${secret.quote}[REDACTED]${secret.quote}`);
    cursor = secret.end;
  }
  parts.push(value.slice(cursor));
  let redacted = parts.join("");
  // URL credentials and query values are never useful in a termination tail.
  redacted = redacted.replace(
    /([a-z][a-z\d+.-]*:\/\/)(?:[^\s/@]+(?::[^\s/@]*)?@)/gi,
    "$1[REDACTED]@",
  );
  redacted = redacted.replace(/([?&][a-z\d_.~-]+)=([^&#\s]+)/gi, "$1=[REDACTED]");
  // JWTs and recognizable provider credentials without a key or header.
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

const utf8Tail = (value: string, limit: number): string => {
  const bytes = encoder.encode(value);
  if (bytes.length <= limit) return value;
  let start = bytes.length - limit;
  // Decoding a sliced code point would insert U+FFFD and can exceed the byte cap.
  while ((bytes[start]! & 0xc0) === 0x80) start++;
  return decoder.decode(bytes.subarray(start));
};

const trimStderr = (value: string) => {
  const tail = utf8Tail(value, MAX_STDERR_DIAGNOSTIC_BYTES);
  if (tail.length === value.length) return { tail, truncated: false, leadingFragment: false };
  const cutoff = value.length - tail.length;
  for (const secret of stderrSecrets(value)) {
    if (secret.start > cutoff || secret.end <= cutoff) continue;
    // Preserve only the parsing context when an open secret spans the cutoff.
    // Its continuation (including whitespace or escaped quotes) must stay secret
    // on later appends, even after the original key has fallen out of the tail.
    const retained = secret.open
      ? `secret=${secret.quote}${secret.escaped ? "\\" : ""}`
      : value.slice(secret.end);
    return { tail: retained, truncated: true, leadingFragment: false };
  }
  return { tail, truncated: true, leadingFragment: true };
};

export const makeStderrDiagnostic = (): StderrDiagnostic => {
  const inputDecoder = new TextDecoder();
  let tail = "";
  let truncated = false;
  let leadingFragment = false;

  return {
    append: (chunk) => {
      const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      const trimmed = trimStderr(tail + inputDecoder.decode(bytes, { stream: true }));
      tail = trimmed.tail;
      if (trimmed.truncated) {
        truncated = true;
        leadingFragment = trimmed.leadingFragment;
      }
    },
    read: () => {
      if (tail.length === 0 && !truncated) return undefined;
      let body = redactStderr(tail);
      // Standalone tokens/URLs may have lost their recognizable prefix.
      if (leadingFragment && body.length > 0 && !/^\s/.test(body)) {
        const end = body.search(/\s/);
        body = `[REDACTED]${end === -1 ? "" : body.slice(end)}`;
      }
      const marker =
        truncated || encoder.encode(body).length > MAX_STDERR_DIAGNOSTIC_BYTES
          ? STDERR_TRUNCATION_MARKER
          : "";
      const available = MAX_STDERR_DIAGNOSTIC_BYTES - encoder.encode(marker).length;
      const bounded = utf8Tail(body, available);
      return `${marker}${bounded}`;
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
