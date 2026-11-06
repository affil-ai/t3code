// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Private, expiring files in a plain Node app.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { PreparedRequest } from "./client.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const safeId = (value: string) => {
  if (!/^[\w-]{1,200}$/.test(value)) throw new Error("Invalid Office article scope.");
  return value;
};

async function privateFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Only connection files expire; the agent's snapshot and edit files remain available for inspection. */
export class ArticleFiles {
  private readonly root: string;
  private readonly repositoryPath: string;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly connections = new Map<
    string,
    {
      chatId: string;
      eventId: string;
      runId?: string | undefined;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(
    home: string,
    repositoryPath: string,
    log: (line: string) => void,
    now: () => number = Date.now,
  ) {
    this.root = NodePath.join(home, "office-article");
    this.repositoryPath = repositoryPath;
    this.log = log;
    this.now = now;
  }

  async restore(): Promise<void> {
    await NodeFSP.mkdir(this.root, { recursive: true, mode: 0o700 });
    await NodeFSP.chmod(this.root, 0o700);
    for (const chat of await NodeFSP.readdir(this.root, { withFileTypes: true })) {
      if (!chat.isDirectory()) continue;
      const directory = NodePath.join(this.root, safeId(chat.name));
      for (const file of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        if (file.isFile() && /^[\w.-]+\.tmp$/.test(file.name)) {
          await NodeFSP.unlink(NodePath.join(directory, file.name));
          continue;
        }
        if (!file.isFile() || !/^[\w-]+\.json$/.test(file.name)) continue;
        const path = NodePath.join(directory, file.name);
        try {
          const article = JSON.parse(await NodeFSP.readFile(path, "utf8")) as {
            expiresAt?: number;
            bridgeEventId?: string;
            bridgeRunId?: string;
          };
          if (typeof article.expiresAt !== "number" || article.expiresAt <= this.now()) {
            await NodeFSP.unlink(path);
          } else {
            await NodeFSP.chmod(path, 0o600);
            this.expire(
              path,
              chat.name,
              article.bridgeEventId ?? "",
              article.expiresAt,
              article.bridgeRunId,
            );
          }
        } catch {
          await NodeFSP.unlink(path);
        }
      }
    }
  }

  async stage(
    chatId: string,
    eventId: string,
    article: NonNullable<PreparedRequest["article"]>,
  ): Promise<string> {
    if (!Number.isFinite(article.expiresAt) || article.expiresAt <= this.now()) {
      throw new Error("Office article access expired. Send the request again.");
    }
    const directory = NodePath.join(this.root, safeId(chatId));
    const runId = safeId(article.runId);
    const connection = NodePath.join(directory, `${runId}.json`);
    const workspace = NodePath.join(directory, runId);
    await NodeFSP.mkdir(workspace, { recursive: true, mode: 0o700 });
    await NodeFSP.chmod(directory, 0o700);
    await NodeFSP.chmod(workspace, 0o700);

    const app = NodePath.resolve(this.repositoryPath, "apps/office");
    const tsx = NodeModule.createRequire(NodePath.join(app, "package.json")).resolve("tsx/cli");
    const command = [
      process.execPath,
      tsx,
      "--tsconfig",
      NodePath.join(app, "tsconfig.json"),
      NodePath.join(app, "scripts/article-workspace.cts"),
    ]
      .map(quote)
      .join(" ");
    const launcher = NodePath.join(directory, `${runId}.sh`);
    await privateFile(
      launcher,
      [
        "#!/bin/sh",
        'case "$1" in',
        `  plan|inspect) exec ${command} "$@" ;;`,
        `  *) exec ${command} --connection ${quote(connection)} "$@" ;;`,
        "esac",
        "",
      ].join("\n"),
    );
    const snapshot = NodePath.join(workspace, "snapshot.json");
    if (article.snapshot !== undefined) {
      await privateFile(
        snapshot,
        typeof article.snapshot === "string" ? article.snapshot : JSON.stringify(article.snapshot),
      );
    }
    await privateFile(connection, JSON.stringify({ ...article, bridgeEventId: eventId }));
    this.expire(connection, chatId, eventId, article.expiresAt);
    return [
      article.instructions,
      `Office article workspace for this request: ${quote(workspace)}. Use absolute paths.`,
      `Command: sh ${quote(launcher)}. It supplies the private connection file ${quote(connection)} for remote commands. Never print or copy that file or its token into messages, logs, or Git.`,
      article.snapshot === undefined
        ? "No snapshot was preloaded. Read the pinned target, or search the corpus before editing."
        : `Current snapshot: ${quote(snapshot)}. Start with sh ${quote(launcher)} inspect ${quote(snapshot)}; no initial remote read is needed.`,
      "Commands: inspect SNAPSHOT_FILE; read TARGET_ID OUTPUT_FILE [SEARCH_RUN_ID]; search QUERY [OPTIONS_FILE]; search-results SEARCH_RUN_ID OUTPUT_FILE [CURSOR]; plan SNAPSHOT_FILE EDIT_MODULE PLAN_FILE; stage TARGET_ID PLAN_FILE [SEARCH_RUN_ID]; review TARGET_ID SNAPSHOT_FILE.",
      'Write edit.mjs with an exported function, for example: export default ({replaceText, suggestMetadata}) => { replaceText("Old phrase", "New phrase"); suggestMetadata("titleTag", "Proposed title"); return {reason: "Requested revision"}; };',
      "replaceText(before, after) requires one exact live match. replaceAllText(before, after, {expectedCount: N}) changes all exact live matches only when the inspected count is N. Both preserve formatting and existing suggestion IDs. A mismatched count requires inspection, not a larger expected count. suggestMetadata(field, after) derives the current value; fields are title, slug, excerpt, titleTag, and metaDescription.",
      "For structural edits the module also receives {transaction, schema, snapshot}. Use native ProseMirror transactions. transaction.doc is the current node; snapshot.document is JSON. Map positions after earlier edits. Never construct tracking marks. A version conflict requires a fresh read and a rebuilt plan.",
      "Run plan, inspect its complete proposed body and metadata decisions, then stage once. plan saves PLAN_FILE.proposed.json; stage verifies the saved article and saves PLAN_FILE.saved.json. Read any truncated output completely in bounded chunks. Review stage's full readback; do not restage automatically when it differs.",
      "For corpus work, wait for search completion and pass the returned searchRunId to read and stage. For an explicit request to accept or reject all suggestions in a pinned chat, inspect snapshot.reviewAction. Only when it is accept or reject, run review with that unmodified snapshot, without staging first. A null reviewAction requires clarification. Corpus review is unsupported; publication is separate.",
      "The connection expires with this run. Use the launcher directly; do not inspect the connection file.",
    ].join("\n\n");
  }

  private expire(
    path: string,
    chatId: string,
    eventId: string,
    expiresAt: number,
    runId?: string,
  ): void {
    clearTimeout(this.connections.get(path)?.timer);
    const timer = setTimeout(
      () => {
        void this.remove(path).catch(() =>
          this.log("Office: failed to remove an expired article connection."),
        );
      },
      Math.min(Math.max(0, expiresAt - this.now()), 2_147_483_647),
    );
    timer.unref();
    this.connections.set(path, { chatId, eventId, runId, timer });
  }

  private async remove(path: string): Promise<void> {
    await NodeFSP.unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    clearTimeout(this.connections.get(path)?.timer);
    this.connections.delete(path);
  }

  async dispatched(eventId: string, runId: string): Promise<void> {
    for (const [path, scope] of this.connections) {
      if (scope.eventId !== eventId) continue;
      const article = JSON.parse(await NodeFSP.readFile(path, "utf8")) as Record<string, unknown>;
      scope.runId = runId;
      await privateFile(path, JSON.stringify({ ...article, bridgeRunId: runId }));
    }
  }

  async complete(chatId: string, runId: string): Promise<void> {
    await Promise.all(
      [...this.connections]
        .filter(([, scope]) => scope.chatId === chatId && scope.runId === runId)
        .map(([path]) => this.remove(path)),
    );
  }

  async close(): Promise<void> {
    for (const scope of this.connections.values()) clearTimeout(scope.timer);
    this.connections.clear();
  }
}
