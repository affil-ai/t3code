// @effect-diagnostics nodeBuiltinImport:off -- Rehearsals use a fresh temporary bridge home.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { assert, expect, it } from "vite-plus/test";

import { createChatState } from "../chatState.ts";
import { BridgeStore, openDatabase } from "../store.ts";
import { T3ToolError } from "../t3Client.ts";
import type { ThreadShape } from "../threads.ts";
import { importOffice } from "./import.ts";
import type { LegacyBinding, LegacyPage, OfficeExport } from "./legacy.ts";

const binding = (
  kind: LegacyBinding["kind"],
  chatId: string,
  extra: Partial<LegacyBinding> = {},
): LegacyBinding => ({
  kind,
  chatId,
  threadId: `office:${chatId}:provision:1`,
  sync: kind === "support",
  ...(kind === "office" ? {} : { slackKey: `slack:C1:${chatId}.1` }),
  ...extra,
});
const shape: ThreadShape = {
  projectId: "office-project",
  title: "Old conversation",
  parentThreadId: null,
  relationshipToParent: null,
  latestRun: { runId: "old-answer", status: "completed" },
};

function fixture() {
  const pages: LegacyPage[] = [
    {
      page: [],
      cursor: "page-2",
      isDone: false,
      counts: {
        seen: 2,
        exported: 0,
        skipped: { revoked: 1, missing_agent_id: 1 },
      },
    },
    { page: [binding("slack", "1"), binding("support", "2")], cursor: "page-3", isDone: false },
    {
      page: [
        binding("office", "3"),
        binding("support", "4"),
        binding("slack", "5"),
        binding("slack", "1"),
      ],
      cursor: null,
      isDone: true,
    },
  ];
  const cursors: Array<string | null> = [];
  const office: OfficeExport = {
    legacyBindings: async (cursor) => {
      cursors.push(cursor);
      return pages[cursor === null ? 0 : cursor === "page-2" ? 1 : 2]!;
    },
  };
  const reads: string[] = [];
  const threads = {
    shape: async (threadId: string) => {
      reads.push(threadId);
      if (threadId === "office:5:provision:1")
        throw new T3ToolError("t3_thread_read", "Thread not found.", "thread_not_found");
      return shape;
    },
  };
  return { office, threads, cursors, reads };
}

async function rehearsalServer(input: ReturnType<typeof fixture>) {
  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const payload = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/query") {
        assert.strictEqual(payload.path, "chatBridge:legacyBindings");
        const args = payload.args[0];
        assert.strictEqual(args.serviceToken, "fake-office-token");
        assert.strictEqual(args.limit, 100);
        response.end(
          JSON.stringify({
            status: "success",
            value: await input.office.legacyBindings(args.cursor),
          }),
        );
        return;
      }
      assert.strictEqual(request.headers.authorization, "Bearer fake-t3-token");
      if (payload.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result;
      if (payload.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "cutover-rehearsal", version: "1" },
        };
      } else {
        assert.strictEqual(payload.method, "tools/call");
        const { name, arguments: args } = payload.params;
        assert.strictEqual(
          args.environmentId,
          name === "t3_environment_read" ? undefined : "shared-test-environment",
        );
        assert.include(
          ["t3_environment_read", "t3_thread_read"],
          name,
          "The importer must never write to T3",
        );
        try {
          const value =
            name === "t3_environment_read"
              ? { environmentId: "shared-test-environment" }
              : {
                  thread: await input.threads.shape(args.threadId),
                  recentRuns: [
                    {
                      runId: "old-answer",
                      ordinal: 1,
                      status: args.threadId === "office:2:provision:1" ? "running" : "completed",
                    },
                  ],
                };
          result = {
            content: [{ type: "text", text: JSON.stringify(value) }],
            structuredContent: value,
          };
        } catch (error) {
          assert.instanceOf(error, T3ToolError);
          result = {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  _tag: "OrchestratorMcpFailure",
                  code: (error as T3ToolError).code,
                  message: "Thread not found.",
                }),
              },
            ],
          };
        }
      }
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
    })().catch(() => response.writeHead(500).end("Rehearsal request failed"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as NodeNet.AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function runImport(home: string, url: string, dryRun: boolean) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
        "import-office",
        ...(dryRun ? ["--dry-run"] : []),
      ],
      {
        env: {
          ...process.env,
          T3_CHAT_BRIDGE_HOME: home,
          T3_TOKEN: "fake-t3-token",
          OFFICE_CONVEX_URL: url,
          OFFICE_CHAT_BRIDGE_TOKEN: "fake-office-token",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Import exited ${code}: ${stderr}`));
        return;
      }
      try {
        assert.notInclude(stdout + stderr, "fake-office-token");
        assert.notInclude(stdout + stderr, "fake-t3-token");
        const rows = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.include(rows[0], { t3Url: url, environmentId: "shared-test-environment", dryRun });
        resolve(rows.at(-1));
      } catch (error) {
        reject(error);
      }
    });
  });
}

it("rehearses paginated dry-run, import, and rerun with a conflict and a missing thread", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bridge-cutover-"));
  const input = fixture();
  const server = await rehearsalServer(input);
  try {
    NodeFS.writeFileSync(
      NodePath.join(home, "config.json"),
      JSON.stringify({
        t3Url: server.url,
        t3EnvironmentId: "shared-test-environment",
        channelProjects: [],
        allowedUserIds: [],
      }),
    );
    const filename = NodePath.join(home, "bridge.db");
    const seed = openDatabase(filename);
    const seededStore = new BridgeStore(seed);
    seededStore.adoptBinding({
      chatThreadKey: "slack:C1:4.1",
      channelId: "C1",
      projectId: "other-project",
      threadId: "do-not-replace",
      createdByUserId: "owner",
    });
    const state = createChatState(seed);
    await state.subscribe("slack:C1:99.1");
    seed.close();
    const before = NodeFS.readFileSync(filename);
    const filesBefore = NodeFS.readdirSync(home);
    const expected = {
      imported: 3,
      unchanged: 1,
      conflicts: 1,
      skipped: { revoked: 1, missing_agent_id: 1, thread_not_found: 1 },
    };
    assert.deepStrictEqual(await runImport(home, server.url, true), { dryRun: true, ...expected });
    assert.deepStrictEqual(NodeFS.readFileSync(filename), before);
    assert.deepStrictEqual(NodeFS.readdirSync(home), filesBefore);
    assert.deepStrictEqual(input.cursors, [null, "page-2", "page-3"]);
    assert.deepStrictEqual(await runImport(home, server.url, false), {
      dryRun: false,
      ...expected,
    });

    const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
    const store = new BridgeStore(db);
    const saved = db.prepare("SELECT * FROM binding ORDER BY chat_thread_key").all();
    assert.lengthOf(saved, 5);
    assert.isUndefined(
      store.binding("office:1"),
      "Slack-linked Office history is not a destination",
    );
    assert.isUndefined(store.binding("office:4"), "A support conflict cannot leave a half-group");
    assert.isUndefined(store.binding("slack:C1:5.1"));
    assert.strictEqual(store.binding("slack:C1:4.1")?.threadId, "do-not-replace");
    assert.isTrue(store.synced("office:2:provision:1"));
    assert.deepStrictEqual(store.recipients("office:2"), ["office:2", "slack:C1:2.1"]);
    assert.deepStrictEqual(
      db
        .prepare("SELECT thread_id FROM state_subscription ORDER BY thread_id")
        .all()
        .map((row) => row.thread_id),
      ["slack:C1:1.1", "slack:C1:2.1", "slack:C1:99.1"],
    );
    for (const table of ["owed_reply", "delegated_follow", "inbox", "question"])
      assert.strictEqual(
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
        0,
        `${table} must stay empty`,
      );
    db.close();

    assert.deepStrictEqual(await runImport(home, server.url, false), {
      dryRun: false,
      ...expected,
      imported: 0,
      unchanged: 4,
    });
    const reread = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
    assert.deepStrictEqual(
      reread.prepare("SELECT * FROM binding ORDER BY chat_thread_key").all(),
      saved,
    );
    reread.close();
    NodeFS.writeFileSync(
      NodePath.join(home, "config.json"),
      JSON.stringify({
        t3Url: server.url,
        t3EnvironmentId: "wrong-environment",
        channelProjects: [],
        allowedUserIds: [],
      }),
    );
    await expect(runImport(home, server.url, true)).rejects.toThrow(
      "Configured t3EnvironmentId does not match this T3 server",
    );
  } finally {
    await server.close();
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("does not create a dry-run home and propagates failures other than missing threads", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bridge-cutover-"));
  const home = NodePath.join(root, "not-created");
  try {
    const office: OfficeExport = {
      legacyBindings: async () => ({
        page: [binding("office", "1")],
        cursor: null,
        isDone: true,
      }),
    };
    const options = { home, dryRun: true, office, report: () => {} };
    assert.deepStrictEqual(
      await importOffice({ ...options, threads: { shape: async () => shape } }),
      { imported: 1, unchanged: 0, skipped: {}, conflicts: 0 },
    );
    assert.isFalse(NodeFS.existsSync(home));
    try {
      await importOffice({
        ...options,
        threads: {
          shape: async () => {
            throw new T3ToolError("t3_thread_read", "Access denied", "forbidden");
          },
        },
      });
      assert.fail("Authentication and server failures must not become skipped threads.");
    } catch (error) {
      assert.instanceOf(error, T3ToolError);
    }
    assert.isFalse(NodeFS.existsSync(home));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("repairs a missing Slack subscription and support sync without replacing existing bindings", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bridge-cutover-"));
  try {
    const db = openDatabase(NodePath.join(home, "bridge.db"));
    const store = new BridgeStore(db);
    for (const chatThreadKey of ["office:2", "slack:C1:2.1"])
      store.adoptBinding({
        chatThreadKey,
        threadId: "office:2:provision:1",
        channelId: "C1",
        projectId: "office-project",
        createdByUserId: "owner",
      });
    db.close();
    const options = {
      home,
      report: () => {},
      threads: { shape: async () => shape },
      office: {
        legacyBindings: async () => ({
          page: [binding("support", "2")],
          cursor: null,
          isDone: true,
        }),
      },
    };
    for (const dryRun of [true, false])
      assert.deepStrictEqual(await importOffice({ ...options, dryRun }), {
        imported: 1,
        unchanged: 0,
        skipped: {},
        conflicts: 0,
      });
    assert.deepStrictEqual(await importOffice({ ...options, dryRun: false }), {
      imported: 0,
      unchanged: 1,
      skipped: {},
      conflicts: 0,
    });
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});
