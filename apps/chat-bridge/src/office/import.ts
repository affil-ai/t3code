// @effect-diagnostics nodeBuiltinImport:off -- Offline CLI import into the bridge's SQLite store.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import { createChatState } from "../chatState.ts";
import { BridgeStore, ensureSchema, openDatabase, type ConversationSeed } from "../store.ts";
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
  return row.kind === "support" || row.kind === "mockup"
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
    const seeds = new Map<string, ConversationSeed>();
    const subscriptions = new Set<string>();
    const seedFor = (key: string) =>
      seeds.get(key) ?? (tables.has("conversation_seed") ? store.seed(key) : undefined);
    const receiptFor = (key: string) =>
      tables.has("seed_receipt") ? store.seedReceipt(key) : undefined;
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
        if (!row.chatId) {
          skip("missing_chat_id");
          continue;
        }
        const keys = conversations(row);
        if (!keys) {
          skip("invalid_slack_key");
          continue;
        }
        if (
          keys.some(({ chatThreadKey }) => {
            const existing = store.binding(chatThreadKey);
            const seed = seedFor(chatThreadKey);
            const receipt = receiptFor(chatThreadKey);
            return (
              (seed !== undefined &&
                (seed.chatId !== row.chatId ||
                  seed.oldThreadId !== row.threadId ||
                  seed.sync !== row.sync)) ||
              (existing !== undefined &&
                (receipt?.chatId !== row.chatId ||
                  receipt.oldThreadId !== row.threadId ||
                  receipt.threadId !== existing.threadId)) ||
              (receipt !== undefined && existing === undefined)
            );
          })
        ) {
          counts.conflicts++;
          report("conflict", "key_has_different_destination");
          continue;
        }
        const slackKey = keys.find((key) => key.chatThreadKey.startsWith("slack:"))?.chatThreadKey;
        const changed =
          keys.some(
            (key) =>
              seedFor(key.chatThreadKey) === undefined &&
              receiptFor(key.chatThreadKey) === undefined,
          ) ||
          (slackKey !== undefined && !isSubscribed(slackKey));
        if (!options.dryRun && changed) {
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const key of keys)
              if (!receiptFor(key.chatThreadKey))
                store.insertSeed({
                  ...key,
                  chatId: row.chatId,
                  oldThreadId: row.threadId,
                  sync: row.sync,
                });
            if (slackKey && !isSubscribed(slackKey)) await state!.subscribe(slackKey);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
        for (const key of keys)
          if (!receiptFor(key.chatThreadKey))
            seeds.set(key.chatThreadKey, {
              ...key,
              chatId: row.chatId,
              oldThreadId: row.threadId,
              sync: row.sync,
            });
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
