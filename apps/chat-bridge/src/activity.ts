/**
 * T3 activity items as task rows: what a run is doing, one row per item, with
 * a short title and a trimmed, redacted output. Plain data, so any chat
 * platform can show it. Nothing here touches Slack or T3.
 */
import { redactSlackSecrets } from "./slackHost.ts";

/** One item from `t3_thread_read` with `view: "activity"`. */
export interface ActivityItem {
  readonly position: number;
  readonly itemId: string;
  readonly type: string;
  readonly runId: string | null;
  readonly status: string;
  readonly title: string | null;
  readonly text: string | null;
  readonly textTruncated?: boolean | undefined;
}

export type TaskStatus = "pending" | "in_progress" | "complete" | "error";

export interface TaskRow {
  /** Stable across updates, so the chat platform updates the row in place. */
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly output?: string | undefined;
  /** Rows show in this order: the item's position in the thread. */
  readonly order: number;
}

export const TITLE_LIMIT = 100;
export const OUTPUT_LIMIT = 400;

/** Item types that are conversation, bookkeeping or shown elsewhere, not work. */
const NOT_A_TASK = new Set([
  "user_message",
  "assistant_message",
  "proposed_plan",
  "checkpoint",
  "notification",
  "system_notice",
  "compaction",
  "handoff",
  "fork",
  "thread_created",
  "run_interrupt_request",
  "run_interrupt_result",
]);

/** Requests that stop the run until a person answers. */
const USER_REQUESTS = new Set([
  "user_input_request",
  "approval_request",
  "secret_request",
  "link_request",
]);

const OPEN_STATUSES = new Set(["idle", "pending", "running", "waiting"]);

/**
 * Secret shapes, after Slack tokens: provider keys, bearer and basic
 * credentials, private keys, JWTs, credentials in URLs, and `name=value`
 * pairs whose name says secret.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "<redacted private key>",
  ],
  [/\b(?:sk|pk|rk)-(?:[a-z]+-)?[A-Za-z0-9_-]{16,}/g, "<redacted>"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "<redacted>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<redacted>"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted>"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "<redacted>"],
  [/\b(?:glpat|npm|pypi|shpat|whsec|rk_live|sk_live|pk_live)[-_][A-Za-z0-9_-]{16,}/g, "<redacted>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted>"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 <redacted>"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, "$1<redacted>@"],
  [
    /\b([A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(\s*[:=]\s*|"\s*:\s*")(["']?)[^\s"',;]{6,}/gi,
    "$1$2$3<redacted>",
  ],
];

/** Removes anything that looks like a secret. */
export function redactSecrets(text: string): string {
  let redacted = redactSlackSecrets(text);
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/** One line, at most `limit` characters. */
export function oneLine(text: string, limit = TITLE_LIMIT): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/**
 * At most `limit` characters. Command output keeps its end, where results and
 * errors are; anything else keeps its start.
 */
export function trimOutput(
  text: string,
  limit = OUTPUT_LIMIT,
  keep: "start" | "end" = "start",
): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return keep === "end" ? `…${trimmed.slice(-(limit - 1))}` : `${trimmed.slice(0, limit - 1)}…`;
}

function taskStatus(status: string): TaskStatus {
  if (status === "completed") return "complete";
  if (status === "failed" || status === "cancelled" || status === "interrupted") return "error";
  if (status === "pending" || status === "idle") return "pending";
  return "in_progress";
}

/** The item's text as JSON, when it is whole and parses. */
function json(item: ActivityItem): Record<string, unknown> | undefined {
  if (item.text === null || item.textTruncated === true) return undefined;
  try {
    const value = JSON.parse(item.text) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const strings = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

const countOf = (value: unknown): number | undefined =>
  Array.isArray(value) ? value.length : undefined;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** A reasoning summary's heading, such as "**Checking the tests**", as a short title. */
function reasoningTitle(item: ActivityItem): string {
  const source = item.title ?? item.text ?? "";
  const firstLine = source.trim().split("\n", 1)[0] ?? "";
  const heading = firstLine
    .replace(/^#+\s*/, "")
    .replace(/\*\*|__/g, "")
    .trim();
  return heading === "" ? "Thinking" : `Thinking: ${oneLine(heading, TITLE_LIMIT - 10)}`;
}

/** `/bin/bash -lc 'pnpm test'` as `pnpm test`: agents wrap each command in a shell. */
export function unwrapShell(command: string): string {
  const match = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return (match?.[2] ?? command).trim();
}

function describe(item: ActivityItem): { title: string; output?: string | undefined } | undefined {
  const text = item.text ?? "";
  switch (item.type) {
    case "reasoning":
      return { title: reasoningTitle(item) };
    case "command_execution": {
      const [first = "", ...rest] = text.split("\n");
      const output = trimOutput(rest.join("\n"), OUTPUT_LIMIT, "end");
      // T3 titles its own steps, such as "Workspace ready"; an agent's command has no title.
      if (item.title) return { title: oneLine(item.title), output };
      const command = unwrapShell(first.startsWith("$ ") ? first.slice(2) : first);
      return {
        title: command === "" ? "Ran a command" : `Ran \`${oneLine(command, TITLE_LIMIT - 8)}\``,
        output,
      };
    }
    case "web_search": {
      const parsed = json(item);
      const patterns = strings(parsed?.patterns);
      const query = patterns[0] ?? item.title ?? "";
      const results = countOf(parsed?.results);
      return {
        title:
          query === ""
            ? "Searched the web"
            : `Searched the web for ${oneLine(query, TITLE_LIMIT - 24)}`,
        output: results === undefined ? undefined : plural(results, "result"),
      };
    }
    case "file_search": {
      const parsed = json(item);
      const pattern = typeof parsed?.pattern === "string" ? parsed.pattern : (item.title ?? "");
      const results = countOf(parsed?.results);
      return {
        title:
          pattern === ""
            ? "Searched files"
            : `Searched files for ${oneLine(pattern, TITLE_LIMIT - 20)}`,
        output: results === undefined ? undefined : plural(results, "match"),
      };
    }
    case "file_change": {
      const [fileName = "", counts = ""] = text.split("\n");
      const name = fileName.trim() || item.title || "";
      return {
        title: name === "" ? "Changed files" : `Edited ${oneLine(name, TITLE_LIMIT - 7)}`,
        output: /^\+\d+ -\d+$/.test(counts.trim()) ? counts.trim() : undefined,
      };
    }
    case "todo_list":
      return { title: "Updated the to-do list", output: trimOutput(text) };
    case "dynamic_tool": {
      const parsed = json(item);
      const tool = typeof parsed?.toolName === "string" ? parsed.toolName : (item.title ?? "");
      return { title: tool === "" ? "Called a tool" : `Called ${oneLine(tool, TITLE_LIMIT - 7)}` };
    }
    case "subagent":
      return {
        title: item.title ? `Subagent: ${oneLine(item.title, TITLE_LIMIT - 10)}` : "Ran a subagent",
        output: trimOutput(text),
      };
    case "user_input_request":
      return { title: "Waiting for your answer in T3 Code" };
    case "approval_request":
      return { title: "Waiting for approval in T3 Code", output: trimOutput(text) };
    case "secret_request":
    case "link_request":
      return { title: "Waiting for you in T3 Code", output: trimOutput(text) };
    case "error":
      return { title: "Error", output: trimOutput(text) };
    default:
      // A tool call T3 added later: show it by its title, if it has one.
      return item.title ? { title: oneLine(item.title) } : undefined;
  }
}

/** The item as a task row, or nothing for conversation and bookkeeping items. */
export function taskRow(item: ActivityItem): TaskRow | undefined {
  if (NOT_A_TASK.has(item.type)) return undefined;
  const described = describe(item);
  if (described === undefined) return undefined;
  const output = described.output ? redactSecrets(described.output) : "";
  return {
    id: item.itemId,
    title: redactSecrets(described.title),
    status: item.type === "error" ? "error" : taskStatus(item.status),
    ...(output === "" ? {} : { output }),
    order: item.position,
  };
}

/** True while the item is still going or waiting. */
export const isOpen = (status: string): boolean => OPEN_STATUSES.has(status);

/** True while the item asks a person for something and has no answer yet. */
export function waitsOnUser(item: ActivityItem): boolean {
  return USER_REQUESTS.has(item.type) && isOpen(item.status);
}
