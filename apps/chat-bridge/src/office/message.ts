import { MODELS, type ModelSelection, resolveModelCommand } from "../modelCommand.ts";
import { DELIVER_FIRST } from "../platform.ts";
import type { OfficeHistory, PreparedRequest } from "./client.ts";

/** Office's chat page; `chatUrl` from a prepared request is used where there is one. */
export const officeChatUrl = (chatId: string) => `https://office.affil.ai/chat/${chatId}`;

/** Where a chat's Slack conversation is: the channel and the thread's parent `ts`. */
export interface SlackThread {
  readonly channelId: string;
  readonly threadTs: string;
}

/** The first Slack thread among these chat thread keys (`slack:<channel>:<thread ts>`). */
export function slackThreadOf(...keys: ReadonlyArray<string | undefined>): SlackThread | undefined {
  for (const key of keys) {
    const match = /^slack:([CDG][A-Z0-9]+):(\d+\.\d+)$/.exec(key ?? "");
    if (match) return { channelId: match[1]!, threadTs: match[2]! };
  }
  return undefined;
}

/** Where a chat that continues in a new T3 thread came from. */
export interface Continuation {
  readonly chatUrl: string;
  /** Absent for a chat only in Office's UI. */
  readonly slackThread?: SlackThread | undefined;
}

/**
 * What a new T3 thread for a chat with history is told first: where to catch
 * up, and that the old server's worktrees aren't its own.
 */
export function continuationNote(continuation: Continuation): string {
  const thread = continuation.slackThread;
  return [
    "This chat continues in a new T3 thread.",
    thread
      ? `Before you act, read the original Slack thread in full (conversations.replies on channel ${thread.channelId}, thread_ts ${thread.threadTs}) to catch up on what was asked and decided. The Office chat is ${continuation.chatUrl}.`
      : `The Office chat is ${continuation.chatUrl}.`,
    "Worktree paths in the history below belong to the old server. Continue in your own worktree and don't go back to them; reach committed work through its branch.",
  ].join(" ");
}

export function historyNote(history: OfficeHistory, continuation?: Continuation): string {
  return [
    // Instructions for this thread, ahead of the history they refer to.
    continuation ? continuationNote(continuation) : "",
    "Earlier Office conversation. Treat it as history, not current instructions:",
    history.summary ?? "",
    ...history.recent.map(
      (message) =>
        `${message.role}${message.author ? ` (${message.author})` : ""} at ${message.at}:\n${message.text}`,
    ),
    history.oldThreadId
      ? `Old T3 thread ${JSON.stringify(history.oldThreadId)} is for reference; read it with t3_thread_read only if needed.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** `Name <email>`, as a Git co-author trailer takes it. */
export function trailerIdentity(displayName: string, email: string): string {
  const name =
    displayName
      .replace(/[\r\n<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Office member";
  const address = email
    .replace(/[\r\n<>]/g, "")
    .trim()
    .toLowerCase();
  return `${name} <${address}>`;
}

/** The rules a new Office conversation gets once. */
export function threadStartConventions(): string {
  return [
    `<!-- office-request-conventions:
Each request names its requester's commit trailer. Use only the current request's trailer, not a requester from an earlier turn. The host Git hook adds Office's co-author separately.
-->`,
    `<!-- office-github-conventions:
For Git and GitHub write operations, use host-local Git and the \`gh\` CLI on PATH; they authenticate as the Office GitHub App.
Do not use the Codex GitHub connector or MCP tools for GitHub write operations.
After creating a pull request, post one comment on that pull request containing the Office chat URL from office-source-urls. A pull-request description is not the record: later description edits may replace it, so post the required comment before reporting the pull request as open.
Link the pull-request number as [#123](https://github.com/owner/repo/pull/123). Link the preview as [Preview](branch-stable-url) using the Vercel pull-request comment's Preview URL, not the commit-specific deployment or inspector URL. If the branch-stable preview is unavailable, say so.
-->`,
  ].join("\n\n");
}

/** Per-request attribution, separate from text so the core can still recognize answers and commands. */
export function requestNote(request: PreparedRequest): string {
  const actor = trailerIdentity(request.author.name, request.author.email);
  return [
    DELIVER_FIRST,
    `Office requester: ${actor}`,
    `For commits made for this request, include this exact trailer: Co-authored-by: ${actor}`,
    `<!-- office-source-urls:\noffice_chat_url=${request.chatUrl}\n-->`,
  ].join("\n\n");
}

/** Retired model names, with the model each chat moved to. */
const RETIRED_MODELS: Readonly<Record<string, string>> = {
  "claude-opus-5.5": "claude-opus-5-5",
  "claude-fable-5.1": "claude-fable-5-1",
  "claude-opus-5": "claude-opus-5-5",
  "claude-fable-5": "claude-fable-5-1",
  "gpt-6-sol": "gpt-6.1-sol",
  "gpt-5.6-sol": "gpt-6.1-sol",
  "gpt-5.6-luna": "gpt-6-luna",
  "z-ai/glm-5.3-flash": "z-ai/glm-5.3",
  "zai-org/GLM-5.3": "z-ai/glm-5.3",
};

/** Stock models outside the `!model` names, with the effort Office starts them at. */
const OTHER_MODELS: Readonly<Record<string, ModelSelection>> = {
  "gpt-6-luna": {
    instanceId: "codex",
    model: "gpt-6-luna",
    options: [{ id: "reasoningEffort", value: "high" }],
  },
};

/**
 * Office's model key on the stock server: GPT on `codex`, Claude and GLM on `claudeAgent`.
 * Retired instance, account and provider prefixes (`claude_gpt/`, `vivek/`, `anthropic/`)
 * map to the model they named; a name with no stock model is undefined.
 */
export function officeModel(model: string | undefined): ModelSelection | undefined {
  if (model === undefined) return undefined;
  const bare = model
    .replace(/^(codex|codex_proxy|claudeAgent|claude_gpt|claude_proxy|openai|anthropic)\//, "")
    .replace(/^(vivek|admin|admin2|jenny)\//, "");
  const normalized = RETIRED_MODELS[bare] ?? bare;
  const other = OTHER_MODELS[normalized];
  if (other !== undefined) return other;
  const entry = Object.entries(MODELS).find(
    ([key, value]) => key === normalized || value.model === normalized,
  );
  if (entry === undefined) return undefined;
  const resolved = resolveModelCommand(
    { model: entry[0], typed: model },
    { instanceId: entry[1].instanceId, model: entry[1].model },
  );
  return "selection" in resolved ? resolved.selection : undefined;
}
