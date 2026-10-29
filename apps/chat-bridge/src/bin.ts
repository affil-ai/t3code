#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- A plain Node app; it does not use Effect.
/**
 * t3-chat-bridge: answers Slack threads with T3 Code threads, against any
 * T3 server, through T3's MCP endpoint.
 *
 *   t3-chat-bridge login [--t3-url URL] [--callback-port 3921]
 *   t3-chat-bridge start
 *   t3-chat-bridge manifest [--name "T3 Code"]
 *
 * Settings live in `<data dir>/config.json` (or `--config FILE`); the data
 * dir is `~/.t3-chat-bridge` unless T3_CHAT_BRIDGE_HOME says otherwise.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { Bridge } from "./bridge.ts";
import { createChatState } from "./chatState.ts";
import { dataDir, loadConfig } from "./config.ts";
import { login, savedToken } from "./login.ts";
import { slackAppManifest } from "./manifest.ts";
import { redactSlackSecrets, type SlackChatHost, startSlackChatHost } from "./slackHost.ts";
import { BridgeStore, openDatabase } from "./store.ts";
import { T3Client } from "./t3Client.ts";
import { T3Threads } from "./threads.ts";
import { startToolServer } from "./toolServer.ts";

const log = (line: string) =>
  process.stderr.write(`${new Date().toISOString()} ${redactSlackSecrets(line)}\n`);
const print = (line: string) => process.stdout.write(`${line}\n`);

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    "t3-url": { type: "string" },
    "callback-port": { type: "string", default: "3921" },
    name: { type: "string", default: "T3 Code" },
  },
});
const dir = dataDir();
const configFile = values.config ?? NodePath.join(dir, "config.json");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}. See apps/chat-bridge/README.md.`);
  return value;
}

async function start(): Promise<void> {
  const config = loadConfig(configFile);
  const token = process.env.T3_TOKEN || savedToken(dir, config.t3Url);
  if (!token)
    throw new Error(`Not signed in to ${config.t3Url}. Run \`t3-chat-bridge login\` first.`);
  const botToken = requireEnv("SLACK_BOT_TOKEN");
  const appToken = requireEnv("SLACK_APP_TOKEN");

  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = openDatabase(NodePath.join(dir, "bridge.db"));
  const store = new BridgeStore(db);
  const t3 = new T3Client(new URL(config.t3Url), token);
  const threads = new T3Threads(
    t3,
    { runtimeMode: config.runtimeMode, modelSelection: config.modelSelection },
    log,
  );
  // Fail now, not on the first Slack message, if T3 or a project is out of reach.
  for (const { projectId } of config.channelProjects) {
    await t3.call("t3_project_read", { projectId });
  }
  if (config.dmProjectId) await t3.call("t3_project_read", { projectId: config.dmProjectId });

  let host: SlackChatHost | undefined;
  const bridge = new Bridge({
    store,
    threads,
    settings: config,
    post: async (reply) => {
      if (host === undefined) throw new Error("Slack is not connected yet.");
      await host.post({ chatThreadKey: reply.chatThreadKey, text: reply.text });
    },
    status: async (chatThreadKey, status) => host?.setStatus(chatThreadKey, status),
    log,
  });
  host = await startSlackChatHost({
    botToken,
    appToken,
    state: createChatState(db),
    onEvent: async (event) => {
      const outcome = await bridge.receive(event);
      log(`${event.eventId}: ${outcome.type}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
      return outcome;
    },
    onError: (error) => log(`Slack message failed: ${String(error)}`),
    log: (level, line) => log(`slack ${level}: ${line}`),
  });
  const slack = host;
  const tools = await startToolServer(
    {
      bindingByChatKey: (chatKey) => store.bindingByChatKey(chatKey),
      workspaceRoots: (threadId) => threads.workspaceRoots(threadId),
      post: (message) => slack.post(message),
      react: (reaction) => slack.react(reaction),
      setStatus: (chatThreadKey, status) => bridge.setStatus(chatThreadKey, status),
    },
    config.toolsPort,
  );
  bridge.resume();
  log(
    `Connected to Slack and ${config.t3Url}. Chat tools at http://127.0.0.1:${config.toolsPort}/mcp`,
  );

  const shutdown = async () => {
    log("Shutting down.");
    bridge.stop();
    tools.close();
    await slack.shutdown().catch(() => {});
    await t3.close();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
  const [command] = positionals;
  if (command === "start") return start();
  if (command === "login") {
    const t3Url = values["t3-url"] ?? loadConfig(configFile).t3Url;
    return login({ t3Url, dataDir: dir, callbackPort: Number(values["callback-port"]), print });
  }
  if (command === "manifest") {
    print(slackAppManifest(values.name));
    return;
  }
  print("Usage: t3-chat-bridge <start | login | manifest>. See apps/chat-bridge/README.md.");
  process.exitCode = command === undefined ? 0 : 1;
}

main().catch((error: unknown) => {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
