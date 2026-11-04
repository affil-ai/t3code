#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- A plain Node app; it does not use Effect.
/**
 * t3-chat-bridge `login | start | manifest`; see README.md. Settings are in
 * `<data dir>/config.json` (or `--config FILE`); the data dir is
 * `~/.t3-chat-bridge` unless T3_CHAT_BRIDGE_HOME says otherwise.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { Chat } from "chat";

import { Bridge, type InboundEvent } from "./bridge.ts";
import { startChatHost } from "./chatHost.ts";
import { createChatState } from "./chatState.ts";
import { dataDir, loadConfig } from "./config.ts";
import { login, savedToken } from "./login.ts";
import { createImessageAdapter } from "./imessage/adapter.ts";
import { imessagePlatform } from "./imessage/platform.ts";
import { slackAppManifest } from "./slack/manifest.ts";
import { type ChatPlatform, platformFor } from "./platform.ts";
import { createSlackHost, redactSlackSecrets, type SlackChatHost } from "./slack/host.ts";
import { slackPlatform } from "./slack/platform.ts";
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
  if (config.imessage)
    await t3.call("t3_project_read", { projectId: config.imessage.route.projectId });

  // One core and one Chat SDK `Chat`; each platform is an adapter on it.
  let chat: Chat | undefined;
  let slackHost: SlackChatHost | undefined;
  let bridge: Bridge | undefined;
  const receive = (event: InboundEvent) => {
    if (bridge === undefined) throw new Error("The bridge is not running yet.");
    return bridge.receive(event);
  };
  const platforms: Array<ChatPlatform> = [
    slackPlatform({
      host: () => slackHost,
      access: { allowedUserIds: config.allowedUserIds, allowEveryone: config.allowEveryone },
      channelRoutes: config.channelProjects,
      directRoute: config.dmProjectId ? { projectId: config.dmProjectId } : undefined,
    }),
  ];
  const imessage = config.imessage
    ? (() => {
        const settings = config.imessage;
        const adapter = createImessageAdapter({
          host: settings.host,
          port: settings.port,
          services: settings.services,
          startAfterRowId: settings.startAfterRowId,
          outboundReactions: settings.outboundReactions,
          log,
        });
        const { platform, deliver } = imessagePlatform({
          chat: () => chat,
          adapter,
          access: {
            allowedUserIds: settings.allowedHandles,
            allowEveryone: settings.allowEveryone,
          },
          route: settings.route,
          onEvent: receive,
        });
        platforms.push(platform);
        return { adapter, deliver };
      })()
    : undefined;
  bridge = new Bridge({
    store,
    threads,
    settings: { followUpMode: config.followUpMode, modelSelection: config.modelSelection },
    platforms,
    log,
  });
  const core = bridge;
  const slackParts = createSlackHost({
    botToken,
    appToken,
    // The bridge logs each outcome as it handles the event.
    onEvent: receive,
    log: (level, line) => log(`slack ${level}: ${line}`),
  });
  chat = await startChatHost({
    adapters: {
      slack: slackParts.adapter,
      ...(imessage ? { imessage: imessage.adapter } : {}),
    },
    deliver: {
      slack: slackParts.deliver,
      ...(imessage ? { imessage: imessage.deliver } : {}),
    },
    state: createChatState(db),
    onError: (error) => log(`Chat message failed: ${String(error)}`),
    onStop: (chatThreadKey, userId) => core.stopRequested(chatThreadKey, userId),
    onAnswer: (chatThreadKey, userId, value) => core.questionClicked(chatThreadKey, userId, value),
    onReaction: (reaction) => core.reacted(reaction),
    log,
  });
  const running = chat;
  const slack = slackParts.connect(running);
  slackHost = slack;
  const tools = await startToolServer(
    {
      bindingByChatKey: (chatKey) => store.bindingByChatKey(chatKey),
      workspaceRoots: (threadId) => threads.workspaceRoots(threadId),
      post: (message) => platformFor(platforms, message.chatThreadKey).post(message),
      react: async (reaction) => {
        const platform = platformFor(platforms, reaction.chatThreadKey);
        if (platform.react === undefined) throw new Error(`${platform.name} has no reactions.`);
        await platform.react(reaction);
      },
      setStatus: (chatThreadKey, status) => core.setStatus(chatThreadKey, status),
    },
    config.toolsPort,
  );
  // What a restart left in the inbox first, then what Slack sent while the bridge was down.
  await core.resume();
  await core.catchUp("slack", (request) => slack.missedEvents(request));
  log(
    `Connected to Slack${imessage ? ", iMessage (connects by itself)" : ""} and ${config.t3Url}. Chat tools at http://127.0.0.1:${config.toolsPort}/mcp`,
  );
  if (config.imessage?.allowEveryone) {
    log(
      "WARNING: imessage.allowEveryone is on. Anyone who sends this Apple account an iMessage can start runs, with this bridge's T3 access.",
    );
  }
  if (config.allowEveryone) {
    log(
      "WARNING: allowEveryone is on. Every full member of this Slack workspace can start runs, and each run has this bridge's T3 access (often full access on this machine, as the user T3 runs as).",
    );
  }

  const shutdown = async () => {
    log("Shutting down.");
    core.stop();
    tools.close();
    await running.shutdown().catch(() => {});
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
