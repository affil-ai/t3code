// @effect-diagnostics globalFetch:off -- A plain Node app; it does not use Effect.
/**
 * A client of a T3 Code server's MCP endpoint, the same one agents use. The
 * bridge drives T3 only through these public tools, so it works with a stock
 * T3 server.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export class T3ToolError extends Error {
  readonly tool: string;
  readonly code: string | undefined;

  constructor(tool: string, message: string, code?: string) {
    super(`${tool}: ${message}`);
    this.name = "T3ToolError";
    this.tool = tool;
    this.code = code;
  }
}

/** The tools the bridge calls. `T3Client` is the live one; tests pass a fake. */
export interface T3Tools {
  call<T>(
    tool: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T>;
  /** POSTs bytes to the upload URL `t3_attachment_prepare_upload` returned. */
  upload(relativeUrl: string, bytes: Uint8Array): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class T3Client implements T3Tools {
  private client: Promise<Client> | undefined;
  /** The T3 server's origin, such as `http://127.0.0.1:3773`. */
  private readonly origin: URL;
  private readonly token: string;
  private readonly environmentId: string | undefined;

  constructor(origin: URL, token: string, environmentId?: string) {
    this.origin = origin;
    this.token = token;
    this.environmentId = environmentId;
  }

  async verifyEnvironment(): Promise<string> {
    const result = await this.call<{ environmentId: string }>("t3_environment_read", {});
    if (this.environmentId && result.environmentId !== this.environmentId)
      throw new Error("Configured t3EnvironmentId does not match this T3 server. Check t3Url.");
    return result.environmentId;
  }

  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const client = new Client({ name: "t3-chat-bridge", version: "0.1.0" });
      const transport = new StreamableHTTPClientTransport(new URL("/mcp", this.origin), {
        requestInit: { headers: { authorization: `Bearer ${this.token}` } },
      });
      // The SDK's own types disagree under exactOptionalPropertyTypes.
      await client.connect(transport as Transport);
      return client;
    })().catch((error: unknown) => {
      this.client = undefined;
      throw error;
    });
    return this.client;
  }

  /** Drops the session, so the next call opens a new one; a restarted T3 forgets old sessions. */
  private async reset(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.then((each) => each.close()).catch(() => {});
  }

  async call<T>(
    tool: string,
    args: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const routed =
      this.environmentId &&
      tool !== "t3_thread_send_attachments" &&
      /^t3_(?:thread_|project_|pending_request)/.test(tool)
        ? { ...args, environmentId: this.environmentId }
        : args;
    const attempt = async () =>
      (await this.connect()).callTool({ name: tool, arguments: routed }, undefined, {
        timeout,
        maxTotalTimeout: timeout,
      });
    let result;
    try {
      result = await attempt();
    } catch (error) {
      await this.reset();
      // A restarted T3 answers an old session with 404 without running the call,
      // so a retry on a new session can't repeat it.
      if (!(error instanceof StreamableHTTPError && error.code === 404)) throw error;
      try {
        result = await attempt();
      } catch (retryError) {
        await this.reset();
        throw retryError;
      }
    }
    if (result.isError) {
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : ""))
        .join(" ")
        .trim();
      const detail = result.structuredContent as Record<string, unknown> | undefined;
      let code = typeof detail?.code === "string" ? detail.code : undefined;
      if (code === undefined) {
        try {
          const failure = JSON.parse(text) as { code?: unknown };
          if (typeof failure.code === "string") code = failure.code;
        } catch {
          // Older tools can return plain text without a structured error code.
        }
      }
      throw new T3ToolError(tool, text || "failed", code);
    }
    return result.structuredContent as T;
  }

  async upload(relativeUrl: string, bytes: Uint8Array): Promise<void> {
    const response = await fetch(new URL(relativeUrl, this.origin), {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        authorization: `Bearer ${this.token}`,
      },
      body: bytes,
    });
    if (!response.ok) {
      throw new Error(
        `Upload failed with ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    }
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
