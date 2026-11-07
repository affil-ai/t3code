// @effect-diagnostics nodeBuiltinImport:off -- Offline CLI import into the bridge's SQLite store.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import { createChatState } from "../chatState.ts";
import { BridgeStore, ensureSchema, openDatabase } from "../store.ts";
import { T3ToolError } from "../t3Client.ts";
import type { T3Threads } from "../threads.ts";
import type { LegacyBinding, OfficeExport } from "./legacy.ts";

export interface ImportCounts {
  imported: number;
  unchanged: number;
  skipped: Record<string, number>;
  conflicts: number;
}

function conversations(row: LegacyBinding) {
  if (row.kind === "office")
    return [{ chatThreadKey: `office:${row.chatId}`, channelId: row.chatId }];
  if (!row.slackKey || !/^slack:[CDG][A-Z0-9]+:\d+\.\d+$/.test(row.slackKey)) return undefined;
  const slack = { chatThreadKey: row.slackKey, channelId: row.slackKey.split(":")[1]! };
  return row.kind === "support"
    ? [{ chatThreadKey: `office:${row.chatId}`, channelId: row.chatId }, slack]
    : [slack];
}

/** Dry runs open existing stores read-only and never create a directory, database, or schema on disk. */
function importDatabase(home: string, dryRun: boolean): NodeSqlite.DatabaseSync {
  const filename = NodePath.join(home, "bridge.db");
  if (!dryRun) {
    NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
    return openDatabase(filename);
  }
  if (NodeFS.existsSync(filename)) {
    const wal = `${filename}-wal`;
    if (NodeFS.existsSync(wal) && NodeFS.statSync(wal).size > 0)
      throw new Error(
        "Stop the bridge and checkpoint bridge.db before a dry-run of an existing store.",
      );
    // SQLite's readOnly mode alone can create WAL/SHM files. Immutable requires a stopped, checkpointed store.
    const url = NodeURL.pathToFileURL(filename);
    url.searchParams.set("immutable", "1");
    return new NodeSqlite.DatabaseSync(url, { readOnly: true });
  }
  const db = new NodeSqlite.DatabaseSync(":memory:");
  ensureSchema(db);
  return db;
}

export async function importOffice(options: {
  home: string;
  dryRun: boolean;
  office: OfficeExport;
  threads: Pick<T3Threads, "shape">;
  report: (row: { chatId: string; threadId: string; status: string; reason?: string }) => void;
}): Promise<ImportCounts> {
  const db = importDatabase(options.home, options.dryRun);
  try {
    const store = new BridgeStore(db);
    const state = options.dryRun ? undefined : createChatState(db);
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    // The overlay makes dry-run duplicates and conflicts behave like a real paginated import.
    const bindings = new Map<string, string>();
    const synced = new Set<string>();
    const subscriptions = new Set<string>();
    const boundThread = (key: string) => bindings.get(key) ?? store.binding(key)?.threadId;
    const isSynced = (threadId: string) =>
      synced.has(threadId) || (tables.has("binding_group") && store.synced(threadId));
    const isSubscribed = (key: string) =>
      subscriptions.has(key) ||
      (tables.has("state_subscription") &&
        db.prepare("SELECT 1 FROM state_subscription WHERE thread_id = ?").get(key) !== undefined);
    const counts: ImportCounts = { imported: 0, unchanged: 0, skipped: {}, conflicts: 0 };
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (;;) {
      const page = await options.office.legacyBindings(cursor);
      for (const [reason, count] of Object.entries(page.counts?.skipped ?? {}))
        counts.skipped[reason] = (counts.skipped[reason] ?? 0) + count;
      for (const row of page.page) {
        const report = (status: string, reason?: string) =>
          options.report({
            chatId: row.chatId,
            threadId: row.threadId,
            status,
            ...(reason ? { reason } : {}),
          });
        const skip = (reason: string) => {
          counts.skipped[reason] = (counts.skipped[reason] ?? 0) + 1;
          report("skipped", reason);
        };
        if (!row.threadId) {
          skip("missing_agent_id");
          continue;
        }
        const keys = conversations(row);
        if (!keys) {
          skip("invalid_slack_key");
          continue;
        }
        if (
          keys.some(({ chatThreadKey }) => {
            const existing = boundThread(chatThreadKey);
            return existing !== undefined && existing !== row.threadId;
          })
        ) {
          counts.conflicts++;
          report("conflict", "key_bound_to_different_thread");
          continue;
        }
        let shape;
        try {
          shape = await options.threads.shape(row.threadId);
        } catch (error) {
          if (!(error instanceof T3ToolError) || error.code !== "thread_not_found") throw error;
          skip("thread_not_found");
          continue;
        }
        const slackKey = keys.find((key) => key.chatThreadKey.startsWith("slack:"))?.chatThreadKey;
        const changed =
          keys.some((key) => boundThread(key.chatThreadKey) === undefined) ||
          (row.kind === "support" && !isSynced(row.threadId)) ||
          (slackKey !== undefined && !isSubscribed(slackKey));
        if (!options.dryRun && changed) {
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const key of keys)
              store.adoptBinding({
                ...key,
                threadId: row.threadId,
                projectId: shape.projectId,
                createdByUserId: "",
              });
            if (row.kind === "support" && !isSynced(row.threadId))
              store.setSync(row.threadId, true);
            if (slackKey && !isSubscribed(slackKey)) await state!.subscribe(slackKey);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
        for (const key of keys) bindings.set(key.chatThreadKey, row.threadId);
        if (row.kind === "support") synced.add(row.threadId);
        if (slackKey) subscriptions.add(slackKey);
        if (changed) counts.imported++;
        else counts.unchanged++;
        report(changed ? "imported" : "unchanged");
      }
      if (page.isDone) break;
      if (!page.cursor || cursors.has(page.cursor))
        throw new Error("Office export cursor did not advance.");
      cursor = page.cursor;
      cursors.add(cursor);
    }
    return counts;
  } finally {
    db.close();
  }
}
