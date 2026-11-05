// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * The agent's way back to its chat: an MCP server on localhost with `chat_post`
 * and `chat_react`. Stock T3 does not tell an MCP server which thread is
 * calling, so each call names its chat thread by the random chat key the
 * bridge wrote into the thread's first turn. The key is the permission.
 */
import * as NodeFSP from "node:fs/promises";
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

import type { OutboundFile, OutboundMessage, Reaction } from "./platform.ts";
import type { Binding } from "./store.ts";

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
}

class ToolInputError extends Error {}

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

export async function callTool(
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
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
  "In those threads your final message in each run is posted to the chat. If a message needs no reply, end the run without a final message and nothing is posted.",
  "The thread's first turn says how that chat works: how to mention people, and which of these tools it supports.",
  "Use chat_post to send files or an update before the run ends, chat_react to react to a message, and chat_status to set the status shown during a long run. All take the thread's chat key.",
].join(" ");

function mcpServer(deps: ToolDeps): Server {
  const server = new Server(
    { name: "t3-chat-bridge", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
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
