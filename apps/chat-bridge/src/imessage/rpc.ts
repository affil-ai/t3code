// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- A plain Node app; it does not use Effect.
/**
 * A JSON-RPC client for the `affil-imessage` service on the Mac (see
 * `mac/affil-imessage.swift`), which speaks `imsg rpc`'s protocol over TCP:
 * one JSON object per line. It reconnects by itself, every few seconds, for
 * as long as it runs.
 */
import * as NodeNet from "node:net";

const RECONNECT_MS = 5_000;
const CALL_TIMEOUT_MS = 120_000;

export interface Notification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export class RpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;

  constructor(message: string, code: number | undefined, data: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface ImsgRpcOptions {
  readonly host: string;
  readonly port: number;
  /** Each notification, such as a new `message`, in order. */
  readonly onNotification: (notification: Notification) => void;
  /** After each (re)connect, such as to catch up on what was missed. */
  readonly onConnect: () => void;
  readonly log: (line: string) => void;
}

export class ImsgRpc {
  private socket: NodeNet.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  private readonly options: ImsgRpcOptions;

  constructor(options: ImsgRpcOptions) {
    this.options = options;
  }

  /** Connects, and keeps reconnecting until `close`. */
  start(): void {
    if (this.closed || this.socket !== undefined) return;
    const socket = NodeNet.connect({ host: this.options.host, port: this.options.port });
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.setKeepAlive(true, 15_000);
    socket.on("connect", () => {
      this.options.log(`Connected to affil-imessage at ${this.options.host}:${this.options.port}.`);
      this.options.onConnect();
    });
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      this.socket = undefined;
      this.buffer = "";
      for (const [id, call] of this.pending) {
        clearTimeout(call.timer);
        call.reject(new Error("The connection to affil-imessage closed."));
        this.pending.delete(id);
      }
      if (this.closed) return;
      setTimeout(() => this.start(), RECONNECT_MS).unref();
    });
  }

  close(): void {
    this.closed = true;
    this.socket?.destroy();
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (socket === undefined || socket.connecting) {
      return Promise.reject(new Error("affil-imessage is not connected."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`affil-imessage didn't answer ${method} in time.`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line === "") continue;
      let message: {
        id?: unknown;
        method?: unknown;
        params?: unknown;
        result?: unknown;
        error?: { message?: string; code?: number; data?: unknown };
      };
      try {
        message = JSON.parse(line);
      } catch {
        this.options.log("affil-imessage sent a line that isn't JSON; ignored.");
        continue;
      }
      if (typeof message.method === "string") {
        this.options.onNotification({
          method: message.method,
          params: (message.params ?? {}) as Record<string, unknown>,
        });
        continue;
      }
      const call = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (call === undefined) continue;
      this.pending.delete(message.id as number);
      clearTimeout(call.timer);
      if (message.error !== undefined) {
        call.reject(
          new RpcError(
            message.error.message ?? "imsg failed.",
            message.error.code,
            message.error.data,
          ),
        );
      } else {
        call.resolve(message.result);
      }
    }
  }
}
