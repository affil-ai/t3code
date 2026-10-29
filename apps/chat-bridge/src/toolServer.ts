// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * The agent's way back to Slack: an MCP server on localhost with `chat_post`
 * and `chat_react`. Stock T3 does not tell an MCP server which thread is
 * calling, so each call names its Slack thread by the random chat key the
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

import type { SlackOutboundFile, SlackOutboundMessage, SlackReaction } from "./slackHost.ts";
import type { Binding } from "./store.ts";

const MAX_FILES = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT = 12_000;
const MESSAGE_ID = /^\d+\.\d+$/;
const EMOJI = /^:?[a-z0-9_+'-]+:?$/;

export interface ToolDeps {
  readonly bindingByChatKey: (chatKey: string) => Binding | undefined;
  /** Folders the thread may share files from. */
  readonly workspaceRoots: (threadId: string) => Promise<ReadonlyArray<string>>;
  readonly post: (message: SlackOutboundMessage) => Promise<void>;
  readonly react: (reaction: SlackReaction) => Promise<void>;
}

class ToolInputError extends Error {}

const TOOLS = [
  {
    name: "chat_post",
    description:
      "Post a message, files, or both to the Slack thread with this chat key. Your final message is posted there anyway, so use this for files and for updates before the run ends. Files must be inside your workspace, up to 10 per call and 50 MB each. Write <@USERID> to mention someone.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatKey: { type: "string", description: "The chat key from the Slack message." },
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
                description: "The name Slack shows; defaults to the file's own.",
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
      "React with an emoji to a message in the Slack thread with this chat key. Pass the message id shown in the turn and a Slack emoji name such as eyes, white_check_mark or thumbsup.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatKey: { type: "string", description: "The chat key from the Slack message." },
        messageId: { type: "string", description: "Such as 1700000000.000100." },
        emoji: { type: "string", description: "A Slack emoji name, with or without colons." },
      },
      required: ["chatKey", "messageId", "emoji"],
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
): Promise<SlackOutboundFile> {
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
      return text("Unknown chat key. Use the one in the Slack message this thread received.", true);
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
      const files: Array<SlackOutboundFile> = [];
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
      await deps.post({ chatThreadKey: binding.chatThreadKey, text: message, files });
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
        return text("emoji must be a Slack emoji name.", true);
      const bare = emoji.replace(/^:|:$/g, "");
      await deps.react({ chatThreadKey: binding.chatThreadKey, messageId, emoji: bare });
      return text(`Reacted with :${bare}:.`);
    }
    return text(`Unknown tool ${name}.`, true);
  } catch (error) {
    if (error instanceof ToolInputError) return text(error.message, true);
    return text(
      `Slack refused the request: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

function mcpServer(deps: ToolDeps): Server {
  const server = new Server(
    { name: "t3-chat-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } },
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
