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

import { createLinearAdapter, type LinearAdapter } from "@chat-adapter/linear";
import type { Chat } from "chat";

import { Bridge, type InboundEvent } from "./bridge.ts";
import { startChatHost } from "./chatHost.ts";
import { createChatState } from "./chatState.ts";
import { dataDir, loadConfig } from "./config.ts";
import { login, savedToken } from "./login.ts";
import { createImessageAdapter } from "./imessage/adapter.ts";
import { type LinearApi, issueKeyOf, linearPlatform, sessionIdOf } from "./linear/platform.ts";
import { authRetry, retryMethods, startInBackground } from "./linear/startup.ts";
import { handlingLinearEvents } from "./linear/stop.ts";
import { imessagePlatform } from "./imessage/platform.ts";
import { slackAppManifest } from "./slack/manifest.ts";
import { type ChatPlatform, platformFor } from "./platform.ts";
import { createSlackHost, redactSlackSecrets, type SlackChatHost } from "./slack/host.ts";
import { slackPlatform, slackWorkNote } from "./slack/platform.ts";
import { BridgeStore, openDatabase } from "./store.ts";
import { T3Client } from "./t3Client.ts";
import { T3Threads } from "./threads.ts";
import { OfficeClient } from "./office/client.ts";
import { createOfficeChannel } from "./office/platform.ts";
import { startToolServer } from "./toolServer.ts";
import { startWebhookServer, type WebhookRoute } from "./webhookServer.ts";

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
  const office = takeOfficeSettings();
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (botToken || appToken) {
    requireEnv("SLACK_BOT_TOKEN");
    requireEnv("SLACK_APP_TOKEN");
  }

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
  for (const { projectId } of config.linear
    ? [config.linear.defaultRoute, ...config.linear.teams]
    : []) {
    await t3.call("t3_project_read", { projectId });
  }

  // One core and one Chat SDK `Chat`; each platform is an adapter on it.
  let chat: Chat | undefined;
  let slackHost: SlackChatHost | undefined;
  let bridge: Bridge | undefined;
  const receive = (event: InboundEvent) => {
    if (bridge === undefined) throw new Error("The bridge is not running yet.");
    return bridge.receive(event);
  };
  const platforms: Array<ChatPlatform> =
    botToken && appToken
      ? [
          slackPlatform({
            host: () => slackHost,
            access: { allowedUserIds: config.allowedUserIds, allowEveryone: config.allowEveryone },
            channelRoutes: config.channelProjects,
            directRoute: config.dmProjectId ? { projectId: config.dmProjectId } : undefined,
          }),
        ]
      : [];
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
  // Linear's secrets come from the environment; without them its webhook answers 503.
  const linearSecrets = config.linear ? takeLinearSecrets() : undefined;
  const linear =
    config.linear && linearSecrets
      ? (() => {
          const settings = config.linear;
          const adapter: LinearAdapter = createLinearAdapter({
            clientCredentials: {
              clientId: linearSecrets.clientId,
              clientSecret: linearSecrets.clientSecret,
              scopes: [
                "read",
                "write",
                "comments:create",
                "issues:create",
                "app:mentionable",
                "app:assignable",
              ],
            },
            webhookSecret: linearSecrets.webhookSecret,
            mode: "agent-sessions",
            userName: settings.botName,
            logger: linearLogger(log),
          });
          // Linear expects a new token after a 401; Chat SDK's calls and the platform's both get one retry.
          const retry = authRetry(
            () =>
              (
                adapter as unknown as { refreshClientCredentialsToken: () => Promise<void> }
              ).refreshClientCredentialsToken(),
            log,
          );
          retryMethods(
            adapter,
            [
              "postMessage",
              "editMessage",
              "deleteMessage",
              "startTyping",
              "addReaction",
              "removeReaction",
              "fetchMessages",
              "fetchMessage",
              "fetchThread",
            ],
            retry,
          );
          // A Linear issue is one conversation; bindings from when each session was one move to
          // their issue, and the session stays the place to answer until a newer one comes.
          for (const key of store.boundKeys("linear:")) {
            if (sessionIdOf(key) === undefined) continue;
            const issueKey = issueKeyOf(key);
            if (store.moveConversation(key, issueKey)) {
              if (store.meta(`linear_session:${issueKey}`) === undefined) {
                store.setMeta(`linear_session:${issueKey}`, key);
              }
              log(`Linear: ${key} is now the conversation for ${issueKey}.`);
            }
          }
          const linearParts = linearPlatform({
            chat: () => chat,
            adapter: () =>
              adapter as unknown as Pick<LinearAdapter, "startTyping"> & {
                readonly botUserId?: string | undefined;
                readonly linearClient: LinearApi;
              },
            access: {
              allowedUserIds: settings.allowedUserIds,
              allowEveryone: settings.allowEveryone,
            },
            teams: settings.teams,
            defaultRoute: settings.defaultRoute,
            onEvent: receive,
            log,
            retry,
            isHandled: (eventId) => store.isHandled(eventId),
            botName: settings.botName,
            ownSessions: {
              has: (sessionId) => store.meta(`linear_own_session:${sessionId}`) !== undefined,
              add: (sessionId) => store.setMeta(`linear_own_session:${sessionId}`, "1"),
            },
            sessions: {
              get: (issueKey) => store.meta(`linear_session:${issueKey}`),
              set: (issueKey, threadId) => store.setMeta(`linear_session:${issueKey}`, threadId),
            },
          });
          const { platform, deliver, comment } = linearParts;
          platforms.push(platform);
          // Chat starts adapters together; Linear's token fetch must not hold up or fail the others.
          const started = startInBackground(adapter, { log });
          return {
            adapter,
            deliver,
            comment,
            parts: linearParts,
            started,
            platform,
            webhookSecret: linearSecrets.webhookSecret,
          };
        })()
      : undefined;
  if (config.linear && !linearSecrets) {
    log(
      `Linear is configured but ${LINEAR_SECRET_NAMES.join(", ")} aren't all set; its webhook answers 503 until they are.`,
    );
  }
  const officeChannel =
    office === undefined
      ? undefined
      : await (async () => {
          const project = await t3.call<{ workspaceRoot: string }>("t3_project_read", {
            projectId: office.projectId,
          });
          const channel = createOfficeChannel({
            api: new OfficeClient(office.convexUrl, office.serviceToken),
            store,
            route: { projectId: office.projectId, worktreeFrom: office.worktreeFrom },
            home: dir,
            repositoryPath: project.workspaceRoot,
            slack: platforms.find((platform) => platform.id === "slack"),
            log,
          });
          platforms.push(channel.platform);
          return channel;
        })();
  bridge = new Bridge({
    store,
    threads,
    settings: { modelSelection: config.modelSelection },
    platforms,
    log,
  });
  const core = bridge;
  const slackParts =
    botToken && appToken
      ? createSlackHost({
          botToken,
          appToken,
          // The bridge logs each outcome as it handles the event.
          onEvent: receive,
          log: (level, line) => log(`slack ${level}: ${line}`),
        })
      : undefined;
  chat =
    slackParts || imessage || linear
      ? await startChatHost({
          adapters: {
            ...(slackParts ? { slack: slackParts.adapter } : {}),
            ...(imessage ? { imessage: imessage.adapter } : {}),
            ...(linear ? { linear: linear.adapter } : {}),
          },
          deliver: {
            ...(slackParts ? { slack: slackParts.deliver } : {}),
            ...(imessage ? { imessage: imessage.deliver } : {}),
            ...(linear ? { linear: linear.deliver } : {}),
          },
          state: createChatState(db),
          onError: (error) => log(`Chat message failed: ${String(error)}`),
          onStop: (chatThreadKey, userId) => core.stopRequested(chatThreadKey, userId),
          onAnswer: (chatThreadKey, userId, value) =>
            core.questionClicked(chatThreadKey, userId, value),
          onReaction: (reaction) => core.reacted(reaction),
          log,
        })
      : undefined;
  const running = chat;
  const slack = running && slackParts?.connect(running);
  slackHost = slack;
  const tools = await startToolServer(
    {
      bindingByChatKey: (chatKey) => store.bindingByChatKey(chatKey),
      workspaceRoots: (threadId) => threads.workspaceRoots(threadId),
      post: (message) => core.postFromAgent(message),
      react: async (reaction) => {
        const platform = platformFor(platforms, reaction.chatThreadKey);
        if (platform.reactionsUnseen !== undefined) return platform.reactionsUnseen;
        if (platform.react === undefined) throw new Error(`${platform.name} has no reactions.`);
        await platform.react(reaction);
        return undefined;
      },
      setStatus: (chatThreadKey, status) => core.setStatus(chatThreadKey, status),
      startSlack: async (request) => {
        const slackPlatform = platforms.find((each) => each.id === "slack");
        if (slackPlatform?.startConversation === undefined)
          throw new Error("Slack isn't connected.");
        const refusal = await core.attachRefusal({ threadId: request.threadId, replace: false });
        if (refusal !== undefined) throw new Error(refusal);
        const chatThreadKey = await slackPlatform.startConversation(request.channel, request.text);
        const channelId = chatThreadKey.split(":")[1] ?? request.channel;
        await core.attach({
          chatThreadKey,
          channelId,
          threadId: request.threadId,
          createdByUserId: "",
          note: (chatKey) => slackWorkNote(chatThreadKey, chatKey),
        });
        return `Started a Slack thread (${chatThreadKey}) for thread ${request.threadId}: replies there continue it, and its final message in each run posts there.`;
      },
      startLinear:
        linear === undefined
          ? undefined
          : async (request) => {
              if (!linear.started.ready())
                throw new Error("Linear is still starting; try again shortly.");
              // Check everything before anything changes in Linear.
              const found = request.issue ? await linear.parts.findIssue(request.issue) : undefined;
              const refusal = await core.attachRefusal({
                threadId: request.threadId,
                chatThreadKey: found ? `linear:${found.issueId}` : undefined,
                replace: request.replace,
              });
              if (refusal !== undefined) throw new Error(refusal);
              const issue = found ?? (await linear.parts.createIssue(request.newIssue!));
              await linear.parts.openSession(issue);
              await core.attach({
                chatThreadKey: `linear:${issue.issueId}`,
                channelId: issue.teamKey,
                threadId: request.threadId,
                createdByUserId: "",
                note: (chatKey) => linear.parts.workNote(issue, chatKey),
              });
              return `${issue.identifier} (${issue.url}) now shows thread ${request.threadId}'s work in a Linear agent session, and its final message in each run posts there.`;
            },
    },
    config.toolsPort,
  );
  const webhookRoutes: Array<WebhookRoute> = config.linear
    ? [
        {
          path: config.linear.webhookPath,
          // Linear names each delivery's type in a header, such as AgentSessionEvent.
          kind: (headers) => headers.get("linear-event") ?? undefined,
          // The adapter checks Linear's signature and timestamp, and refuses anything else.
          // Until Linear is up, 503 asks Linear to deliver again later.
          handle: linear
            ? (() => {
                // A signed "Send stop request" interrupts the issue's run and a signed new comment is
                // kept as context; everything else is the adapter's.
                const handle = handlingLinearEvents(
                  (request) => linear.adapter.handleWebhook(request),
                  {
                    secret: linear.webhookSecret,
                    log,
                    onComment: (comment) => linear.comment(comment),
                    onStop: async (stop) => {
                      const issueKey = `linear:${stop.issueId}`;
                      // The final word goes to the session the stop came from.
                      store.setMeta(
                        `linear_session:${issueKey}`,
                        `${issueKey}:s:${stop.sessionId}`,
                      );
                      const wasRunning = core.hasRunInFlight(issueKey);
                      await core.stopRequested(issueKey, stop.userId);
                      // Linear wants a final activity after a stop; a stopped run posts its own.
                      if (!wasRunning) {
                        await linear.platform
                          .post({ chatThreadKey: issueKey, text: "Nothing was running." })
                          .catch((error: unknown) =>
                            log(`Linear: answering a stop failed: ${String(error)}`),
                          );
                      }
                    },
                  },
                );
                return async (request: Request) =>
                  linear.started.ready()
                    ? handle(request)
                    : new Response("Linear is still starting.", { status: 503 });
              })()
            : async () => new Response("Linear isn't set up on this bridge yet.", { status: 503 }),
        },
      ]
    : [];
  const webhooks =
    config.linear === undefined
      ? undefined
      : await startWebhookServer(config.linear.webhookPort, webhookRoutes, log);
  // What a restart left in the inbox first, then what Slack sent while the bridge was down.
  await officeChannel?.start(core);
  await core.resume();
  if (slack) await core.catchUp("slack", (request) => slack.missedEvents(request));
  log(
    `Connected channels: ${platforms.map((platform) => platform.name).join(", ")}. T3: ${config.t3Url}. Chat tools at http://127.0.0.1:${config.toolsPort}/mcp`,
  );
  if (webhooks && config.linear) {
    log(`Linear webhook on http://127.0.0.1:${webhooks.port}${config.linear.webhookPath}.`);
  }
  if (config.imessage?.allowEveryone) {
    log(
      "WARNING: imessage.allowEveryone is on. Anyone who sends this Apple account an iMessage can start runs, with this bridge's T3 access.",
    );
  }
  if (officeChannel) log("Office channel subscribed.");
  if (slack && config.allowEveryone) {
    log(
      "WARNING: allowEveryone is on. Every full member of this Slack workspace can start runs, and each run has this bridge's T3 access (often full access on this machine, as the user T3 runs as).",
    );
  }

  const shutdown = async () => {
    log("Shutting down.");
    core.stop();
    await officeChannel?.close();
    tools.close();
    webhooks?.close();
    linear?.started.stop();
    await running?.shutdown().catch(() => {});
    await t3.close();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

/**
 * Office's channel settings, when it is on. The service token is removed from
 * the environment, like Linear's secrets.
 */
function takeOfficeSettings():
  | {
      readonly convexUrl: string;
      readonly serviceToken: string;
      readonly projectId: string;
      readonly worktreeFrom: string | undefined;
    }
  | undefined {
  const serviceToken = process.env.OFFICE_CHAT_BRIDGE_TOKEN;
  delete process.env.OFFICE_CHAT_BRIDGE_TOKEN;
  const convexUrl = process.env.OFFICE_CONVEX_URL;
  const projectId = process.env.OFFICE_T3_PROJECT_ID;
  if (!serviceToken && !convexUrl) return undefined;
  if (!serviceToken || !convexUrl || !projectId) {
    throw new Error(
      "Office requires OFFICE_CONVEX_URL, OFFICE_CHAT_BRIDGE_TOKEN, and OFFICE_T3_PROJECT_ID.",
    );
  }
  return {
    convexUrl,
    serviceToken,
    projectId,
    worktreeFrom: process.env.OFFICE_WORKTREE_FROM || undefined,
  };
}

const LINEAR_SECRET_NAMES = ["LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET", "LINEAR_WEBHOOK_SECRET"];

/**
 * Reads Linear's secrets and removes them from the environment, so nothing
 * else (the adapter's own auto-detection included) picks them up.
 */
function takeLinearSecrets():
  | { readonly clientId: string; readonly clientSecret: string; readonly webhookSecret: string }
  | undefined {
  const [clientId, clientSecret, webhookSecret] = LINEAR_SECRET_NAMES.map((name) => {
    const value = process.env[name];
    delete process.env[name];
    return value;
  });
  return clientId && clientSecret && webhookSecret
    ? { clientId, clientSecret, webhookSecret }
    : undefined;
}

/** The adapter's warnings and errors, without its debug lines, which carry payloads. */
function linearLogger(log: (line: string) => void) {
  const line =
    (level: string) =>
    (message: string, ...args: Array<unknown>) =>
      log(
        `linear ${level}: ${[message, ...args.map((arg) => (arg instanceof Error ? arg.message : JSON.stringify(arg)))].join(" ").slice(0, 500)}`,
      );
  const logger = {
    debug: () => {},
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
    child: () => logger,
  };
  return logger;
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
