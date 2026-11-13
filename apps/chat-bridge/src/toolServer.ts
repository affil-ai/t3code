// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * The agent's way back to its chat: an MCP server on localhost with `chat_post`
 * and `chat_react`. Stock T3 does not tell an MCP server which thread is
 * calling, so each call names its chat thread by the random chat key the
 * bridge wrote into the thread's first turn. The key is the permission.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { type OutboundFile, type OutboundMessage, QUIET_RULES, type Reaction } from "./platform.ts";
import type { Binding } from "./store.ts";
import { SLACK_REPLY_STYLE } from "./slack/platform.ts";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT = 12_000;
const MAX_STATUS = 100;
/** A platform's message id, such as Slack's `ts` or an iMessage or Linear id. */
const MESSAGE_ID = /^[\w.:-]{1,100}$/;
const EMOJI = /^:?[a-z0-9_+'-]+:?$/;

export interface ToolDeps {
  readonly bindingByChatKey: (chatKey: string) => Binding | undefined;
  /** Folders the thread may share files from. */
  readonly workspaceRoots: (threadId: string) => Promise<ReadonlyArray<string>>;
  readonly post: (message: OutboundMessage) => Promise<void>;
  /** Reacts, or says why it didn't: a note for the agent in place of "Reacted". */
  readonly react: (reaction: Reaction) => Promise<string | undefined>;
  /** Sets the status of the thread's runs in flight; false when there is none. */
  readonly setStatus: (chatThreadKey: string, status: string) => boolean;
  /** Disconnects the chat thread from its T3 thread. */
  readonly unlink: (chatThreadKey: string) => void;
  /** Connects a thread to a Linear issue; absent without Linear. Returns what to tell the caller. */
  readonly startLinear?: ((request: LinearStartRequest) => Promise<string>) | undefined;
  /** Starts a Slack thread for a thread; absent without Slack. Returns what to tell the caller. */
  readonly startSlack?: ((request: SlackStartRequest) => Promise<string>) | undefined;
}

export interface LinearStartRequest {
  readonly threadId: string;
  /** An existing issue, such as ENG-123. */
  readonly issue?: string | undefined;
  readonly newIssue?:
    | { readonly team: string; readonly title: string; readonly description?: string | undefined }
    | undefined;
  /** Move an issue that already goes to another thread. */
  readonly replace: boolean;
  readonly sync?: boolean | undefined;
}

export interface SlackStartRequest {
  readonly threadId: string;
  /** A channel id the bot is in (C…, G…, D…), or a person's user id (U…, W…) for a DM. */
  readonly channel: string;
  readonly text: string;
  /**
   * The timestamp of an existing message in `channel` to reply under, such as
   * 1794278854.319499 from a permalink's p1794278854319499. That Slack thread
   * then continues the T3 thread instead of a new top-level message.
   */
  readonly replyTo?: string | undefined;
  readonly sync?: boolean | undefined;
}

const ISSUE_ID = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,7}$/;
const THREAD_ID = /^[\w.:%-]{1,300}$/;
const SLACK_ID = /^[CGDUW][A-Z0-9]{2,20}$/;
const SLACK_TS = /^\d{9,12}\.\d{6}$/;
const MAX_OPENING = 4_000;

const SYNC_PROPERTY = {
  type: "boolean",
  description:
    "For a thread with several chats: true posts every final message to all of them and copies each chat's messages into the others; false goes back to each run answering only the chat that started it (the default).",
};

const THREAD_ID_PROPERTY = {
  type: "string",
  description:
    "The T3 thread to connect: your own (orchestrator_capabilities returns it as parentThreadId) or a subagent's childThreadId from delegate_task.",
};

const LINEAR_START_TOOL = {
  name: "linear_start",
  description:
    "Connect a T3 thread to a Linear issue: its progress and final message show in the issue's agent session, and later prompts there continue the thread. Pass your own thread id to take your work to Linear, or a subagent's childThreadId (its completion still wakes you). Give either issue (an existing one, such as ENG-123) or newIssue. A thread already connected to other chats keeps them; each run's final message goes to the chat that started it. No chat key needed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      threadId: THREAD_ID_PROPERTY,
      issue: { type: "string", description: "An existing issue's identifier, such as ENG-123." },
      newIssue: {
        type: "object",
        description: "An issue to create instead.",
        properties: {
          team: { type: "string", description: "The team key, such as ENG." },
          title: { type: "string", maxLength: 255 },
          description: { type: "string", maxLength: 20_000, description: "Markdown." },
        },
        required: ["team", "title"],
      },
      replace: {
        type: "boolean",
        description: "Move an issue that already goes to another thread to this one.",
      },
      sync: SYNC_PROPERTY,
    },
    required: ["threadId"],
  },
};

const SLACK_START_TOOL = {
  name: "slack_start",
  description:
    "Start a Slack thread for a T3 thread: posts text as a new message in a channel the bot is in, or as a DM to a person, or as a reply under an existing message with replyTo, and replies in that Slack thread continue the T3 thread. The thread's final message in each run is posted there from then on. A thread already connected to other chats keeps them; each later run's final message goes to the chat that started it. Pass your own thread id, or a subagent's childThreadId. No chat key needed.",
  inputSchema: {
    type: "object" as const,
    properties: {
      threadId: THREAD_ID_PROPERTY,
      channel: {
        type: "string",
        description:
          "A Slack channel id the bot is in (C…, G…), or a person's member id (U…) for a DM.",
      },
      text: {
        type: "string",
        maxLength: MAX_OPENING,
        description: "The opening message, in Markdown.",
      },
      replyTo: {
        type: "string",
        description:
          "Reply under this existing message instead of starting a new one: its ts, such as 1794278854.319499 (a permalink's p1794278854319499 with a dot before the last six digits). Use the thread's parent message, not a reply.",
      },
      sync: SYNC_PROPERTY,
    },
    required: ["threadId", "channel", "text"],
  },
};

class ToolInputError extends Error {}

/**
 * Why `slack_start` may not post to `channel`, or undefined when it may: only a
 * configured channel, or a DM to someone allowed to use the bot.
 */
export function slackStartRefusal(
  access: {
    readonly channelProjects: ReadonlyArray<{ readonly channelId: string }>;
    readonly allowedUserIds: ReadonlyArray<string>;
    readonly allowEveryone: boolean;
  },
  channel: string,
): string | undefined {
  if (channel.startsWith("U") || channel.startsWith("W")) {
    if (access.allowEveryone || access.allowedUserIds.includes(channel)) return undefined;
    return `${channel} isn't allowed to use the bot, so slack_start won't DM them.`;
  }
  if (access.channelProjects.some((route) => route.channelId === channel)) return undefined;
  return `${channel} isn't one of the bridge's channels, so slack_start won't post there.`;
}

const TOOLS = [
  {
    name: "chat_post",
    description:
      "Post a message, files, or both to the chat thread with this chat key. Your final message is posted there anyway, so use this for files and for updates before the run ends. Files must be inside your workspace, up to 10 per call and 50 MB each. The thread's first turn says how to mention people there.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatKey: { type: "string", description: "The chat key from the chat message." },
        text: { type: "string", maxLength: MAX_TEXT },
        files: {
          type: "array",
          maxItems: MAX_FILES,
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Absolute, or relative to your workspace." },
              name: {
                type: "string",
                description: "The name the chat shows; defaults to the file's own.",
              },
            },
            required: ["path"],
          },
        },
      },
      required: ["chatKey"],
    },
  },
  {
    name: "chat_react",
    description:
      "React with an emoji to a message in the chat thread with this chat key. Pass the message id shown in the turn and an emoji name such as eyes, white_check_mark or thumbsup. The thread's first turn says whether reactions work there and which ones.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatKey: { type: "string", description: "The chat key from the chat message." },
        messageId: { type: "string", description: "Such as 1700000000.000100." },
        emoji: { type: "string", description: "An emoji name, with or without colons." },
      },
      required: ["chatKey", "messageId", "emoji"],
    },
  },
  {
    name: "chat_unlink",
    description:
      "Disconnect the chat thread with this chat key from your T3 thread: nothing more is posted there, its later messages no longer reach you, and a new mention there starts a new T3 thread. Your other chats stay connected. Post anything it should see first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatKey: { type: "string", description: "The chat key of the chat to disconnect." },
      },
      required: ["chatKey"],
    },
  },
  {
    name: "chat_status",
    description:
      'Set the status shown under the chat thread with this chat key, such as "Running the tests", until your next step. Your commands, searches and edits show there already, so use this for a phase of work they don\'t name.',
    inputSchema: {
      type: "object" as const,
      properties: {
        chatKey: { type: "string", description: "The chat key from the chat message." },
        status: { type: "string", maxLength: MAX_STATUS },
      },
      required: ["chatKey", "status"],
    },
  },
];

const text = (value: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text: value }],
  ...(isError ? { isError: true } : {}),
});

const stringArg = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ToolInputError(`${key} must be a string.`);
  return value;
};

/** Reads a file under one of `roots`; a NodePath that resolves outside them is refused. */
async function readWorkspaceFile(
  roots: ReadonlyArray<string>,
  file: { readonly path: string; readonly name?: string | undefined },
): Promise<OutboundFile> {
  const [first] = roots;
  if (first === undefined)
    throw new ToolInputError("This thread has no workspace, so it cannot send files.");
  const realRoots = await Promise.all(
    roots.map((root) => NodeFSP.realpath(root).catch(() => undefined)),
  );
  const resolved = await NodeFSP.realpath(NodePath.resolve(first, file.path)).catch(() => {
    throw new ToolInputError(`${file.path} does not exist.`);
  });
  const inside = realRoots.some((root) => {
    if (root === undefined) return false;
    const relative = NodePath.relative(root, resolved);
    return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
  });
  if (!inside)
    throw new ToolInputError(`${file.path} is outside the workspace. Copy it into ${first} first.`);
  const info = await NodeFSP.stat(resolved);
  if (!info.isFile()) throw new ToolInputError(`${file.path} is not a file.`);
  if (info.size > MAX_FILE_BYTES) {
    throw new ToolInputError(`${file.path} is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
  }
  return {
    data: await NodeFSP.readFile(resolved),
    filename: file.name ?? NodePath.basename(resolved),
  };
}

function threadIdArg(args: Record<string, unknown>): string {
  // Earlier versions called it childThreadId.
  const threadId = (stringArg(args, "threadId") ?? stringArg(args, "childThreadId"))?.trim() ?? "";
  if (!THREAD_ID.test(threadId)) {
    throw new ToolInputError(
      "threadId must be a T3 thread id, such as your own or a childThreadId.",
    );
  }
  return threadId;
}

function syncArg(args: Record<string, unknown>): { sync?: boolean } {
  if (args.sync === undefined) return {};
  if (typeof args.sync !== "boolean") throw new ToolInputError("sync must be true or false.");
  return { sync: args.sync };
}

function slackStartRequest(args: Record<string, unknown>): SlackStartRequest {
  const threadId = threadIdArg(args);
  const channel = stringArg(args, "channel")?.trim() ?? "";
  if (!SLACK_ID.test(channel)) {
    throw new ToolInputError("channel must be a Slack channel id (C…, G…, D…) or member id (U…).");
  }
  const text = stringArg(args, "text")?.trim() ?? "";
  if (text === "" || text.length > MAX_OPENING) {
    throw new ToolInputError(`text must be 1 to ${MAX_OPENING} characters.`);
  }
  const replyTo = stringArg(args, "replyTo")?.trim() || undefined;
  if (replyTo !== undefined) {
    if (!SLACK_TS.test(replyTo)) {
      throw new ToolInputError("replyTo must be a Slack message ts, such as 1794278854.319499.");
    }
    if (!/^[CG]/.test(channel)) {
      throw new ToolInputError("replyTo needs a channel id (C…, G…), not a DM or member id.");
    }
  }
  return {
    threadId,
    channel,
    text,
    ...(replyTo === undefined ? {} : { replyTo }),
    ...syncArg(args),
  };
}

function linearStartRequest(args: Record<string, unknown>): LinearStartRequest {
  const threadId = threadIdArg(args);
  const issue = stringArg(args, "issue")?.trim();
  const raw = args.newIssue;
  if ((issue === undefined) === (raw === undefined)) {
    throw new ToolInputError("Pass either issue or newIssue.");
  }
  if (issue !== undefined && !ISSUE_ID.test(issue)) {
    throw new ToolInputError("issue must be an identifier such as ENG-123.");
  }
  let newIssue: LinearStartRequest["newIssue"];
  if (raw !== undefined) {
    if (typeof raw !== "object" || raw === null)
      throw new ToolInputError("newIssue must be an object.");
    const fields = raw as Record<string, unknown>;
    const team = stringArg(fields, "team")?.trim() ?? "";
    const title = stringArg(fields, "title")?.trim() ?? "";
    const description = stringArg(fields, "description");
    if (!/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(team))
      throw new ToolInputError("newIssue.team must be a team key.");
    if (title === "" || title.length > 255)
      throw new ToolInputError("newIssue.title must be 1 to 255 characters.");
    if (description !== undefined && description.length > 20_000) {
      throw new ToolInputError("newIssue.description is longer than 20000 characters.");
    }
    newIssue = { team, title, description };
  }
  if (args.replace !== undefined && typeof args.replace !== "boolean") {
    throw new ToolInputError("replace must be true or false.");
  }
  return { threadId, issue, newIssue, replace: args.replace === true, ...syncArg(args) };
}

export async function callTool(
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  invocationId: string = NodeCrypto.randomUUID(),
): Promise<CallToolResult> {
  try {
    if (name === "linear_start") {
      if (deps.startLinear === undefined) return text("Linear isn't set up on this bridge.", true);
      return text(await deps.startLinear(linearStartRequest(args)));
    }
    if (name === "slack_start") {
      if (deps.startSlack === undefined) return text("Slack isn't set up on this bridge.", true);
      return text(await deps.startSlack(slackStartRequest(args)));
    }
    const chatKey = stringArg(args, "chatKey") ?? "";
    const binding = deps.bindingByChatKey(chatKey);
    if (binding === undefined) {
      return text("Unknown chat key. Use the one in the chat message this thread received.", true);
    }
    if (name === "chat_post") {
      const message = stringArg(args, "text")?.trim() ?? "";
      const requested = Array.isArray(args.files)
        ? (args.files as Array<Record<string, unknown>>)
        : [];
      if (message === "" && requested.length === 0) return text("Pass text, files, or both.", true);
      if (message.length > MAX_TEXT)
        return text(`text is longer than ${MAX_TEXT} characters.`, true);
      if (requested.length > MAX_FILES)
        return text(`Send at most ${MAX_FILES} files per call.`, true);
      const files: Array<OutboundFile> = [];
      if (requested.length > 0) {
        const roots = await deps.workspaceRoots(binding.threadId);
        for (const file of requested) {
          const filePath = stringArg(file, "path");
          if (!filePath) return text("Each file needs a path.", true);
          files.push(
            await readWorkspaceFile(roots, { path: filePath, name: stringArg(file, "name") }),
          );
        }
      }
      // Mid-run: the run's own final message is the answer.
      await deps.post({
        eventId: `tool:${binding.threadId}:${invocationId}`,
        chatThreadKey: binding.chatThreadKey,
        text: message,
        files,
        kind: "update",
      });
      return text(
        files.length === 0 ? "Posted." : `Posted ${files.map((file) => file.filename).join(", ")}.`,
      );
    }
    if (name === "chat_react") {
      const messageId = stringArg(args, "messageId") ?? "";
      const emoji = stringArg(args, "emoji") ?? "";
      if (!MESSAGE_ID.test(messageId))
        return text("messageId must look like 1700000000.000100.", true);
      if (!EMOJI.test(emoji) || emoji.length > 100)
        return text("emoji must be an emoji name.", true);
      const bare = emoji.replace(/^:|:$/g, "");
      const instead = await deps.react({
        chatThreadKey: binding.chatThreadKey,
        messageId,
        emoji: bare,
      });
      return text(instead ?? `Reacted with :${bare}:.`);
    }
    if (name === "chat_unlink") {
      deps.unlink(binding.chatThreadKey);
      return text(
        `Disconnected ${binding.chatThreadKey} from thread ${binding.threadId}; its chat key no longer works.`,
      );
    }
    if (name === "chat_status") {
      const status = stringArg(args, "status")?.trim() ?? "";
      if (status === "" || status.length > MAX_STATUS)
        return text(`status must be 1 to ${MAX_STATUS} characters.`, true);
      if (!deps.setStatus(binding.chatThreadKey, status))
        return text("This chat thread has no run in flight, so there is no status to set.", true);
      return text("Status set.");
    }
    return text(`Unknown tool ${name}.`, true);
  } catch (error) {
    if (error instanceof ToolInputError) return text(error.message, true);
    return text(
      `The chat refused the request: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

/**
 * Sent to the agent when it connects, so it knows how chat threads work
 * even after its first turn has been compacted away.
 */
const INSTRUCTIONS = [
  "Some threads take their messages from a chat, such as a Slack thread, an iMessage conversation or a Linear agent session. Their turns start with the chat message and carry a chat key.",
  "In those threads your final message in each run is posted to the chat whose message started the run.",
  "A thread can have several chats, each with its own chat key; chat_post and the other chat tools reach only the chat whose key you pass.",
  QUIET_RULES,
  "The thread's first turn says how that chat works: how to mention people, and which of these tools it supports.",
  "Use chat_post to send files or an update before the run ends, chat_react to react to a message, and chat_status to set the status shown during a long run. All take the thread's chat key.",
  `In a Slack thread: ${SLACK_REPLY_STYLE}`,
].join(" ");

function mcpServer(deps: ToolDeps): Server {
  const server = new Server(
    { name: "t3-chat-bridge", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...TOOLS,
      ...(deps.startLinear === undefined ? [] : [LINEAR_START_TOOL]),
      ...(deps.startSlack === undefined ? [] : [SLACK_START_TOOL]),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callTool(deps, request.params.name, request.params.arguments ?? {}),
  );
  return server;
}

/** Serves the tools at `http://127.0.0.1:<port>/mcp`, statelessly: each request gets its own server. */
export async function startToolServer(deps: ToolDeps, port: number): Promise<NodeHttp.Server> {
  const http = NodeHttp.createServer((request, response) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    const server = mcpServer(deps);
    // The SDK's own types disagree under exactOptionalPropertyTypes; stateless mode needs `undefined`.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined as unknown as () => string,
      // A web page cannot reach it by pointing its own hostname at 127.0.0.1.
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport as Transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => resolve());
  });
  return http;
}
