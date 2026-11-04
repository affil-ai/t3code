// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * The bridge's settings file. Secrets never go here: Slack tokens come from
 * the environment, and the T3 login is saved separately by `login`.
 */
import type { ModelSelection } from "./modelCommand.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ChannelRoute } from "./bridge.ts";
import type { FollowUpMode } from "./threads.ts";

export interface BridgeConfig {
  /** The T3 server's origin, such as `http://127.0.0.1:3773`. */
  readonly t3Url: string;
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
  /** `steer` joins a reply to the run in flight; `queue` runs it after. */
  readonly followUpMode: FollowUpMode;
  /** The port of the `chat_post` / `chat_react` MCP server on 127.0.0.1. */
  readonly toolsPort: number;
  /** For new threads; T3 caps it at what the login was granted. Omit for T3's default. */
  readonly runtimeMode?: string | undefined;
  /**
   * For new threads, such as `{ "instanceId": "claudeAgent", "model": "claude-opus-5-5",
   * "options": [{ "id": "effort", "value": "medium" }] }`. Omit for the project's default.
   */
  readonly modelSelection?: ModelSelection | undefined;
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
    : fail(`channelProjects ${field} must be non-empty text.`);
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

export function parseConfig(raw: unknown): BridgeConfig {
  if (!isRecord(raw)) return fail("The config must be a JSON object.");
  const t3Url = typeof raw.t3Url === "string" ? raw.t3Url : fail("t3Url is required.");
  if (!URL.canParse(t3Url)) fail(`t3Url is not a URL: ${t3Url}`);
  const channelProjects = Array.isArray(raw.channelProjects)
    ? raw.channelProjects.map(parseRoute)
    : fail("channelProjects must be a list.");
  const followUpMode = raw.followUpMode ?? "steer";
  if (followUpMode !== "steer" && followUpMode !== "queue") {
    fail('followUpMode must be "steer" or "queue".');
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
    channelProjects,
    dmProjectId: raw.dmProjectId as string | undefined,
    allowedUserIds: stringList(raw.allowedUserIds, "allowedUserIds"),
    followUpMode: followUpMode as FollowUpMode,
    toolsPort: toolsPort as number,
    runtimeMode: raw.runtimeMode as string | undefined,
    modelSelection: raw.modelSelection as ModelSelection | undefined,
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
