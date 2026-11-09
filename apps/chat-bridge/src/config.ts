// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * The bridge's settings file. Secrets never go here: Slack tokens come from
 * the environment, and the T3 login is saved separately by `login`.
 */
import type { ModelSelection } from "./modelCommand.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ChannelRoute, ThreadRoute } from "./platform.ts";

export interface BridgeConfig {
  /** The T3 server's origin, such as `http://127.0.0.1:3773`. */
  readonly t3Url: string;
  /** Pins thread and project calls to this environment on the configured server. */
  readonly t3EnvironmentId?: string | undefined;
  /**
   * Which T3 project a mention in each Slack channel starts its thread in. A
   * channel may have several entries; the first whose `match` the message
   * contains, or the first without `match`, wins.
   */
  readonly channelProjects: ReadonlyArray<ChannelRoute>;
  /** The T3 project a direct message to the bot starts its thread in. Omit to ignore direct messages. */
  readonly dmProjectId?: string | undefined;
  /** Slack user ids who may use the bot. Everyone else gets a short refusal. */
  readonly allowedUserIds: ReadonlyArray<string>;
  /** Also allow every full member of the workspace. Off unless set to true. */
  readonly allowEveryone: boolean;
  /** `steer` joins a reply to the run in flight; `queue` runs it after. */
  /** The port of the `chat_post` / `chat_react` MCP server on 127.0.0.1. */
  readonly toolsPort: number;
  /**
   * Serve `slack_start` and `linear_start`. Off unless set to true: they take no chat
   * key, so every agent on the T3 server could call them.
   */
  readonly startTools: boolean;
  /** For new threads; T3 caps it at what the login was granted. Omit for T3's default. */
  readonly runtimeMode?: string | undefined;
  /**
   * For new threads, such as `{ "instanceId": "claudeAgent", "model": "claude-opus-5-5",
   * "options": [{ "id": "effort", "value": "medium" }] }`. Omit for the project's default.
   */
  readonly modelSelection?: ModelSelection | undefined;
  /** iMessage through `affil-imessage` on a Mac. Omit to run without iMessage. */
  readonly imessage?: ImessageConfig | undefined;
  /** Linear agent sessions. Omit to run without Linear. Its secrets come from the environment. */
  readonly linear?: LinearConfig | undefined;
}

export interface LinearConfig {
  /** The app's name in Linear, as people @mention it, such as "office". */
  readonly botName: string;
  /** The loopback port of the webhook server; public ingress forwards `webhookPath` to it. */
  readonly webhookPort: number;
  readonly webhookPath: string;
  /** Where a session on an issue of a team without its own route starts its thread. */
  readonly defaultRoute: ThreadRoute;
  /** Per-team routes, by team key (the "ENG" in ENG-123). */
  readonly teams: ReadonlyArray<ThreadRoute & { readonly team: string }>;
  /** Linear user ids that may use the agent; with `allowEveryone`, anyone in the workspace. */
  readonly allowedUserIds: ReadonlyArray<string>;
  /** On by default: anyone in the Linear workspace who can mention the app may use it. */
  readonly allowEveryone: boolean;
}

export interface ImessageConfig {
  /** Where `affil-imessage` listens, usually an SSH tunnel to the Mac: `127.0.0.1:47821`. */
  readonly host: string;
  readonly port: number;
  /** Where each new conversation starts its thread: a project, and optionally a new worktree and a note. */
  readonly route: ThreadRoute;
  /** Phone numbers and emails, as Messages shows them, that may use the bot. */
  readonly allowedHandles: ReadonlyArray<string>;
  /** Also allow anyone who messages the account. Off unless set to true. */
  readonly allowEveryone: boolean;
  /** Messages services to read. Default `["iMessage"]`; others, such as SMS, are left alone. */
  readonly services: ReadonlyArray<string>;
  /** On the very first start, also answer messages after this Messages row id. */
  readonly startAfterRowId?: number | undefined;
  /**
   * Let the agent send tapbacks. They need imsg's private Messages bridge (SIP
   * off on the Mac, then `imsg launch`), and stay off until it runs. Default off.
   */
  readonly outboundReactions: boolean;
}

export const DEFAULT_TOOLS_PORT = 3920;

export function dataDir(): string {
  return process.env.T3_CHAT_BRIDGE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3-chat-bridge");
}

class ConfigError extends Error {}

const fail = (message: string): never => {
  throw new ConfigError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: unknown, field: string): Array<string> =>
  Array.isArray(value) && value.every((each) => typeof each === "string" && each !== "")
    ? value
    : fail(`${field} must be a list of ids.`);

const optionalText = (entry: Record<string, unknown>, field: string): string | undefined => {
  const value = entry[field];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.trim() !== ""
    ? value
    : fail(`${field} must be non-empty text.`);
};

function parseRoute(entry: unknown): ChannelRoute {
  if (
    !isRecord(entry) ||
    typeof entry.channelId !== "string" ||
    typeof entry.projectId !== "string"
  )
    return fail("Each channelProjects entry needs channelId and projectId.");
  const match = optionalText(entry, "match");
  const worktreeFrom = optionalText(entry, "worktreeFrom");
  const note = optionalText(entry, "note");
  return {
    channelId: entry.channelId,
    projectId: entry.projectId,
    ...(match === undefined ? {} : { match }),
    ...(worktreeFrom === undefined ? {} : { worktreeFrom }),
    ...(note === undefined ? {} : { note }),
  };
}

function parseImessage(raw: unknown): ImessageConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return fail("imessage must be an object.");
  const host = raw.host ?? "127.0.0.1";
  const port = raw.port ?? 47821;
  if (typeof host !== "string" || host === "") fail("imessage.host must be a host name.");
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    fail("imessage.port must be a port number.");
  }
  if (typeof raw.projectId !== "string" || raw.projectId === "") {
    fail("imessage.projectId is required.");
  }
  for (const field of ["allowEveryone", "outboundReactions"]) {
    if (raw[field] !== undefined && typeof raw[field] !== "boolean") {
      fail(`imessage.${field} must be true or false.`);
    }
  }
  if (
    raw.startAfterRowId !== undefined &&
    (typeof raw.startAfterRowId !== "number" || !Number.isInteger(raw.startAfterRowId))
  ) {
    fail("imessage.startAfterRowId must be a whole number.");
  }
  const worktreeFrom = optionalText(raw, "worktreeFrom");
  const note = optionalText(raw, "note");
  return {
    host: host as string,
    port: port as number,
    route: {
      projectId: raw.projectId as string,
      ...(worktreeFrom === undefined ? {} : { worktreeFrom }),
      ...(note === undefined ? {} : { note }),
    },
    allowedHandles:
      raw.allowedHandles === undefined
        ? []
        : stringList(raw.allowedHandles, "imessage.allowedHandles"),
    allowEveryone: raw.allowEveryone === true,
    services:
      raw.services === undefined ? ["iMessage"] : stringList(raw.services, "imessage.services"),
    startAfterRowId: raw.startAfterRowId as number | undefined,
    outboundReactions: raw.outboundReactions === true,
  };
}

function parseThreadRoute(raw: Record<string, unknown>, field: string): ThreadRoute {
  if (typeof raw.projectId !== "string" || raw.projectId === "")
    fail(`${field}.projectId is required.`);
  const worktreeFrom = optionalText(raw, "worktreeFrom");
  const note = optionalText(raw, "note");
  return {
    projectId: raw.projectId as string,
    ...(worktreeFrom === undefined ? {} : { worktreeFrom }),
    ...(note === undefined ? {} : { note }),
  };
}

function parseLinear(raw: unknown): LinearConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return fail("linear must be an object.");
  const port = raw.webhookPort ?? 3930;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    fail("linear.webhookPort must be a port number.");
  }
  const path = raw.webhookPath ?? "/linear/webhook";
  if (typeof path !== "string" || !path.startsWith("/"))
    fail("linear.webhookPath must start with /.");
  if (raw.allowEveryone !== undefined && typeof raw.allowEveryone !== "boolean") {
    fail("linear.allowEveryone must be true or false.");
  }
  const teams = raw.teams ?? [];
  if (!Array.isArray(teams)) fail("linear.teams must be a list.");
  return {
    botName: typeof raw.botName === "string" && raw.botName !== "" ? raw.botName : "office",
    webhookPort: port as number,
    webhookPath: path as string,
    defaultRoute: parseThreadRoute(raw, "linear"),
    teams: (teams as Array<unknown>).map((entry) => {
      if (!isRecord(entry) || typeof entry.team !== "string" || entry.team === "") {
        return fail("Each linear.teams entry needs a team key.");
      }
      return { team: entry.team, ...parseThreadRoute(entry, `linear.teams ${entry.team}`) };
    }),
    allowedUserIds:
      raw.allowedUserIds === undefined
        ? []
        : stringList(raw.allowedUserIds, "linear.allowedUserIds"),
    allowEveryone: raw.allowEveryone !== false,
  };
}

export function parseConfig(raw: unknown): BridgeConfig {
  if (!isRecord(raw)) return fail("The config must be a JSON object.");
  const t3Url = typeof raw.t3Url === "string" ? raw.t3Url : fail("t3Url is required.");
  if (!URL.canParse(t3Url)) fail(`t3Url is not a URL: ${t3Url}`);
  const channelProjects = Array.isArray(raw.channelProjects)
    ? raw.channelProjects.map(parseRoute)
    : fail("channelProjects must be a list.");
  // Follow-ups always steer the run in flight; the old setting is accepted only as "steer".
  if (raw.followUpMode !== undefined && raw.followUpMode !== "steer") {
    fail("followUpMode was removed: replies always steer the run in flight. Remove the setting.");
  }
  const toolsPort = raw.toolsPort ?? DEFAULT_TOOLS_PORT;
  if (typeof toolsPort !== "number" || !Number.isInteger(toolsPort) || toolsPort <= 0) {
    fail("toolsPort must be a port number.");
  }
  if (
    raw.dmProjectId !== undefined &&
    (typeof raw.dmProjectId !== "string" || raw.dmProjectId === "")
  ) {
    fail("dmProjectId must be a project id.");
  }
  if (raw.allowEveryone !== undefined && typeof raw.allowEveryone !== "boolean") {
    fail("allowEveryone must be true or false.");
  }
  if (raw.startTools !== undefined && typeof raw.startTools !== "boolean") {
    fail("startTools must be true or false.");
  }
  if (raw.runtimeMode !== undefined && typeof raw.runtimeMode !== "string") {
    fail("runtimeMode must be a string.");
  }
  if (
    raw.modelSelection !== undefined &&
    (!isRecord(raw.modelSelection) ||
      typeof raw.modelSelection.instanceId !== "string" ||
      typeof raw.modelSelection.model !== "string" ||
      (raw.modelSelection.options !== undefined && !Array.isArray(raw.modelSelection.options)))
  ) {
    fail("modelSelection needs an instanceId and a model, and options must be a list.");
  }
  return {
    t3Url,
    t3EnvironmentId: optionalText(raw, "t3EnvironmentId"),
    channelProjects,
    dmProjectId: raw.dmProjectId as string | undefined,
    allowedUserIds: stringList(raw.allowedUserIds, "allowedUserIds"),
    allowEveryone: raw.allowEveryone === true,
    toolsPort: toolsPort as number,
    startTools: raw.startTools === true,
    runtimeMode: raw.runtimeMode as string | undefined,
    modelSelection: raw.modelSelection as ModelSelection | undefined,
    imessage: parseImessage(raw.imessage),
    linear: parseLinear(raw.linear),
  };
}

export function loadConfig(file: string): BridgeConfig {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch {
    return fail(`No config at ${file}. See apps/chat-bridge/README.md.`);
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (error) {
    if (error instanceof ConfigError) throw new ConfigError(`${file}: ${error.message}`);
    return fail(`${file} is not valid JSON.`);
  }
}
