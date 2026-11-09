import { MODELS, type ModelSelection, resolveModelCommand } from "../modelCommand.ts";
import type { OfficeHistory, PreparedRequest } from "./client.ts";

export function historyNote(history: OfficeHistory): string {
  return [
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
    `Office requester: ${actor}`,
    `For commits made for this request, include this exact trailer: Co-authored-by: ${actor}`,
    `<!-- office-source-urls:\noffice_chat_url=${request.chatUrl}\n-->`,
  ].join("\n\n");
}

/** Only model names the bridge knows are mapped; unknown account or model names use the host default. */
export function officeModel(model: string | undefined): ModelSelection | undefined {
  if (model === undefined) return undefined;
  const normalized = model
    .replace(/^(anthropic|openai|codex|claudeAgent)\//, "")
    .replace("claude-opus-5.5", "claude-opus-5-5")
    .replace("claude-fable-5.1", "claude-fable-5-1");
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
