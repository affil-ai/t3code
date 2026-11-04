/**
 * What a T3 run is doing now, as one short line in the present tense, such as
 * "Running `pnpm test`" or "Searching the web for slack streams". Slack shows
 * it in the thread's status, the way Devin and Office do. Nothing here
 * touches Slack or T3.
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

/** Slack's status takes up to 50 characters. */
export const STATUS_LIMIT = 50;
export const THINKING = "Thinking…";

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
export function oneLine(text: string, limit = STATUS_LIMIT): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
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

const firstString = (value: unknown): string | undefined =>
  Array.isArray(value) ? value.find((each): each is string => typeof each === "string") : undefined;

/** A reasoning summary's heading, such as "**Checking the tests**", or thinking. */
function reasoningLine(item: ActivityItem): string {
  const source = item.title ?? item.text ?? "";
  const firstLine = source.trim().split("\n", 1)[0] ?? "";
  const heading = firstLine
    .replace(/^#+\s*/, "")
    .replace(/\*\*|__/g, "")
    .trim();
  return heading === "" ? THINKING : heading;
}

/** `/bin/bash -lc 'pnpm test'` as `pnpm test`: agents wrap each command in a shell. */
export function unwrapShell(command: string): string {
  const trimmed = command.trim();
  const match = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)$/.exec(trimmed);
  if (match === null) return trimmed;
  const [, quote = "", body = ""] = match;
  // The first line of a multi-line script has no closing quote; mark that more follows.
  return body.endsWith(quote) ? body.slice(0, -1).trim() : `${body.trim()} …`;
}

/** T3's own setup steps, such as preparing the workspace; not the agent's work. */
const isSetupStep = (item: ActivityItem) =>
  item.type === "command_execution" &&
  (item.title === "Workspace ready" || (item.text ?? "").startsWith("$ Preparing workspace"));

/** What the item is doing, as a line for the status; nothing for items that aren't work. */
function describe(item: ActivityItem): string | undefined {
  const text = item.text ?? "";
  const with_ = (prefix: string, value: string | undefined | null, fallback: string) => {
    const trimmed = (value ?? "").trim();
    return trimmed === "" ? fallback : `${prefix}${trimmed}`;
  };
  switch (item.type) {
    case "reasoning":
      return reasoningLine(item);
    case "command_execution": {
      if (isSetupStep(item)) return undefined;
      // T3 titles its own steps; an agent's command has no title.
      if (item.title) return item.title;
      const first = text.split("\n", 1)[0] ?? "";
      const command = unwrapShell(first.startsWith("$ ") ? first.slice(2) : first);
      return with_("Running ", command && `\`${command}\``, "Running a command");
    }
    case "web_search":
      return with_(
        "Searching the web for ",
        firstString(json(item)?.patterns) ?? item.title,
        "Searching the web",
      );
    case "file_search": {
      const pattern = json(item)?.pattern;
      return with_(
        "Searching files for ",
        typeof pattern === "string" ? pattern : item.title,
        "Searching files",
      );
    }
    case "file_change":
      return with_("Editing ", text.split("\n", 1)[0] || item.title, "Editing files");
    case "todo_list":
      return "Planning";
    case "dynamic_tool": {
      const parsed = json(item);
      // A long tool output is cut off, so the JSON doesn't parse; its name comes first.
      const named = /"toolName":\s*"([^"]+)"/.exec(text)?.[1];
      const tool = typeof parsed?.toolName === "string" ? parsed.toolName : named;
      return with_("Using ", tool?.split(".").at(-1)?.replaceAll("_", " "), "Using a tool");
    }
    case "subagent":
      return with_("Delegating: ", item.title, "Delegating to a subagent");
    default:
      return undefined;
  }
}

/** The line for one item, redacted and short; nothing for items that aren't work. */
export function statusLine(item: ActivityItem): string | undefined {
  const line = describe(item);
  return line === undefined ? undefined : oneLine(redactSecrets(line));
}

/**
 * The status for a run: the newest step still going, or thinking between
 * steps.
 */
export function currentStatus(items: ReadonlyArray<ActivityItem>): string {
  // A finished step means the agent is reading its result, so it is thinking.
  const going = items
    .filter((item) => isOpen(item.status))
    .flatMap((item) => {
      const line = statusLine(item);
      return line === undefined ? [] : [line];
    });
  return going.at(-1) ?? THINKING;
}

/** True while the item is still going or waiting. */
export const isOpen = (status: string): boolean => OPEN_STATUSES.has(status);

/** A question for the person in the chat. */
export const isQuestion = (item: ActivityItem): boolean =>
  item.type === "user_input_request" && isOpen(item.status);

/** A permission request, which only T3 itself can grant. */
export const isPermissionRequest = (item: ActivityItem): boolean =>
  item.type === "approval_request" && isOpen(item.status);
