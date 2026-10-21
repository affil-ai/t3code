import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError, type GenericId } from "convex/values";
import { z } from "zod";
import type { ComponentApi } from "../component/_generated/component.js";

const MAX_BODY_BYTES = 29 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 20 * 1024 * 1024;
const inputSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
const replySchema = z
  .object({
    reply_key: z.string().min(1),
    text: z.string().trim().min(1).max(100_000),
    final: z.boolean().optional(),
    files: z
      .array(
        z
          .object({
            filename: z.string(),
            mimeType: z.string().min(1),
            data: z.string(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
type RpcId = string | number | null;
type HostContext = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "storage">;

export async function handleReplyRequest(
  ctx: HostContext,
  component: ComponentApi,
  request: Request,
  authorize: (request: Request) => boolean | Promise<boolean>,
): Promise<Response> {
  if (!(await authorize(request)))
    return new Response("Unauthorized", {
      status: 401,
      headers: { "cache-control": "no-store", "www-authenticate": "Bearer" },
    });
  let body: string;
  try {
    body = await readBody(request);
  } catch {
    return new Response("Payload too large", {
      status: 413,
      headers: { "cache-control": "no-store" },
    });
  }
  let input: z.infer<typeof inputSchema>;
  try {
    input = inputSchema.parse(JSON.parse(body));
  } catch {
    return rpcError(null, -32600, "Invalid JSON-RPC request");
  }
  if (input.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (input.method === "initialize")
    return rpcResult(input.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "convex-t3-bridge", version: "0.1.0" },
    });
  if (input.method === "tools/list")
    return rpcResult(input.id, {
      tools: [
        {
          name: "reply",
          description:
            "Send an interim or final reply to the conversation identified by t3_reply_key.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["reply_key", "text"],
            properties: {
              reply_key: { type: "string" },
              text: { type: "string" },
              final: { type: "boolean" },
              files: {
                type: "array",
                maxItems: 10,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["filename", "mimeType", "data"],
                  properties: {
                    filename: { type: "string" },
                    mimeType: { type: "string" },
                    data: { type: "string", description: "Base64-encoded file bytes." },
                  },
                },
              },
            },
          },
        },
      ],
    });
  if (input.method !== "tools/call") return rpcError(input.id, -32601, "Unsupported MCP method");
  try {
    const params = z
      .object({ name: z.literal("reply"), arguments: replySchema })
      .parse(input.params);
    const args = params.arguments;
    await ctx.runQuery(component.bridge.authorizeReply, { replyKey: args.reply_key });
    // Decode and validate all files before storing the first one.
    let total = 0;
    const resolved = [];
    for (const file of args.files ?? []) {
      const bytes = decodeBase64(file.data);
      total += bytes.byteLength;
      if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES)
        throw new Error("T3_BRIDGE_FILE_TOO_LARGE");
      if (total > MAX_TOTAL_FILE_BYTES) throw new Error("T3_BRIDGE_FILE_TOTAL_TOO_LARGE");
      const mimeType = file.mimeType.trim();
      if (mimeType.length > 200 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mimeType))
        throw new Error("T3_BRIDGE_INVALID_FILE_TYPE");
      const filename =
        [...file.filename.normalize("NFKC")]
          .map((character) =>
            character === "\\" ||
            character === "/" ||
            character.charCodeAt(0) < 32 ||
            character.charCodeAt(0) === 127
              ? "_"
              : character,
          )
          .join("")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 180) || "attachment";
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha256 = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      resolved.push({ filename, mimeType, bytes, sha256 });
    }
    const stored: GenericId<"_storage">[] = [];
    try {
      const files = [];
      for (const file of resolved) {
        const storageId = await ctx.storage.store(new Blob([file.bytes], { type: file.mimeType }));
        stored.push(storageId);
        files.push({
          filename: file.filename,
          mimeType: file.mimeType,
          byteSize: file.bytes.byteLength,
          sha256: file.sha256,
          storageId,
        });
      }
      const result = await ctx.runMutation(component.bridge.recordReply, {
        replyKey: args.reply_key,
        text: args.text,
        final: args.final,
        files,
      });
      return rpcResult(input.id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    } catch (error) {
      await Promise.all(stored.map((id) => ctx.storage.delete(id)));
      throw error;
    }
  } catch (error) {
    // Do not return raw validation payloads, keys, or callback exception messages.
    const data =
      error instanceof ConvexError ? error.data : error instanceof Error ? error.message : "";
    const message =
      typeof data === "string" && /^T3_BRIDGE_[A-Z_]+$/.test(data)
        ? data
        : "T3_BRIDGE_REPLY_REJECTED";
    return rpcResult(input.id, { isError: true, content: [{ type: "text", text: message }] });
  }
}

function decodeBase64(data: string) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4)
    throw new Error("T3_BRIDGE_INVALID_BASE64");
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
async function readBody(request: Request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
function rpcResult(id: RpcId | undefined, result: unknown) {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, result },
    { headers: { "cache-control": "no-store" } },
  );
}
function rpcError(id: RpcId | undefined, code: number, message: string) {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}
