// @effect-diagnostics nodeBuiltinImport:off -- Rehearsals use a fresh temporary bridge home.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, expect, it } from "vite-plus/test";

import { createChatState } from "../chatState.ts";
import { BridgeStore, openDatabase } from "../store.ts";
import { importOffice } from "./import.ts";
import { runOfficeImport } from "./importCommand.ts";
import type { LegacyBinding, LegacyPage, OfficeExport } from "./legacy.ts";

const binding = (
  kind: LegacyBinding["kind"],
  chatId: string,
  extra: Partial<LegacyBinding> = {},
): LegacyBinding => ({
  kind,
  chatId,
  threadId: `office:${chatId}:provision:1`,
  sync: kind === "support" || kind === "mockup",
  ...(kind === "office" ? {} : { slackKey: `slack:C1:${chatId}.1` }),
  ...extra,
});

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
        binding("mockup", "6"),
        binding("schedule", "7"),
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
  return { office, cursors };
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
      response.setHeader("connection", "close");
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
        assert.equal(name, "t3_environment_read", "Seeds never read or adopt the old T3 threads");
        const value = { environmentId: "shared-test-environment" };
        result = {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        };
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

async function runImport(home: string, url: string, dryRun: boolean) {
  const output: string[] = [];
  await runOfficeImport({
    home,
    configFile: NodePath.join(home, "config.json"),
    dryRun,
    office: { convexUrl: url, serviceToken: "fake-office-token" },
    token: "fake-t3-token",
    print: (line) => {
      output.push(line);
    },
  });
  assert.notInclude(output.join("\n"), "fake-office-token");
  assert.notInclude(output.join("\n"), "fake-t3-token");
  const rows = output.map((line) => JSON.parse(line));
  assert.include(rows[0], { t3Url: url, environmentId: "shared-test-environment", dryRun });
  return rows.at(-1);
}

it("rehearses paginated dry-run, import, and rerun without needing old threads", async () => {
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
      imported: 6,
      unchanged: 1,
      conflicts: 1,
      skipped: { revoked: 1, missing_agent_id: 1 },
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
    const saved = db.prepare("SELECT * FROM conversation_seed ORDER BY chat_thread_key").all();
    assert.lengthOf(saved, 8);
    assert.isUndefined(
      store.binding("office:1"),
      "Slack-linked Office history is not a destination",
    );
    assert.isUndefined(store.binding("office:4"), "A support conflict cannot leave a half-group");
    assert.isDefined(store.seed("slack:C1:5.1"));
    assert.strictEqual(store.binding("slack:C1:4.1")?.threadId, "do-not-replace");
    assert.deepStrictEqual(
      store.seeds("2").map((seed) => seed.chatThreadKey),
      ["office:2", "slack:C1:2.1"],
    );
    assert.isTrue(store.seed("office:6")?.sync);
    assert.isFalse(store.seed("slack:C1:7.1")?.sync);
    assert.isUndefined(store.seed("office:7"));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM binding").get()?.n, 1);
    assert.deepStrictEqual(
      db
        .prepare("SELECT thread_id FROM state_subscription ORDER BY thread_id")
        .all()
        .map((row) => row.thread_id),
      [
        "slack:C1:1.1",
        "slack:C1:2.1",
        "slack:C1:5.1",
        "slack:C1:6.1",
        "slack:C1:7.1",
        "slack:C1:99.1",
      ],
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
      unchanged: 7,
    });
    const reread = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
    assert.deepStrictEqual(
      reread.prepare("SELECT * FROM conversation_seed ORDER BY chat_thread_key").all(),
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

it("does not create a dry-run home and propagates Office export failures", async () => {
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
    assert.deepStrictEqual(await importOffice(options), {
      imported: 1,
      unchanged: 0,
      skipped: {},
      conflicts: 0,
    });
    assert.isFalse(NodeFS.existsSync(home));
    await expect(
      importOffice({
        ...options,
        office: {
          legacyBindings: async () => {
            throw new Error("Office unavailable");
          },
        },
      }),
    ).rejects.toThrow("Office unavailable");
    assert.isFalse(NodeFS.existsSync(home));
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it("repairs seed subscriptions and preserves a completed import on rerun", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bridge-cutover-"));
  try {
    const db = openDatabase(NodePath.join(home, "bridge.db"));
    const store = new BridgeStore(db);
    for (const chatThreadKey of ["office:2", "slack:C1:2.1"])
      store.insertSeed({
        chatThreadKey,
        oldThreadId: "office:2:provision:1",
        channelId: "C1",
        chatId: "2",
        sync: true,
      });
    db.close();
    const options = {
      home,
      report: () => {},
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
    const converted = openDatabase(NodePath.join(home, "bridge.db"));
    const convertedStore = new BridgeStore(converted);
    convertedStore.consumeSeed(convertedStore.seed("office:2")!, {
      chatThreadKey: "office:2",
      channelId: "2",
      threadId: "new-thread",
      projectId: "project",
      chatKey: "private",
      createdByUserId: "member",
    });
    assert.isUndefined(convertedStore.seed("office:2"));
    converted.close();
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
