// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * Inbound webhooks for platforms that need them, such as Linear, on loopback
 * only. Public ingress (Tailscale Funnel, a Cloudflare tunnel) is outside the
 * bridge and forwards only the paths here; each handler checks its own signatures.
 */
import * as NodeHttp from "node:http";

const MAX_BODY_BYTES = 1024 * 1024;

export interface WebhookRoute {
  /** The exact path, such as `/linear/webhook`. Anything else gets 404. */
  readonly path: string;
  readonly handle: (request: Request) => Promise<Response>;
}

export interface WebhookServer {
  readonly port: number;
  readonly close: () => void;
}

/** Turns one Node request into a fetch `Request`, or a status code to answer with. */
async function toRequest(
  request: NodeHttp.IncomingMessage,
  routes: ReadonlyArray<WebhookRoute>,
): Promise<{ readonly route: WebhookRoute; readonly request: Request } | number> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const route = routes.find((each) => each.path === path);
  if (route === undefined) return 404;
  if (request.method !== "POST") return 405;
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return 413;
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return {
    route,
    request: new Request(`http://127.0.0.1${path}`, {
      method: "POST",
      headers,
      body: Buffer.concat(chunks),
    }),
  };
}

export function startWebhookServer(
  port: number,
  routes: ReadonlyArray<WebhookRoute>,
  log: (line: string) => void,
): Promise<WebhookServer> {
  const server = NodeHttp.createServer((incoming, outgoing) => {
    void (async () => {
      let response: Response;
      try {
        const parsed = await toRequest(incoming, routes);
        response =
          typeof parsed === "number"
            ? new Response(null, { status: parsed })
            : await parsed.route.handle(parsed.request);
      } catch (error) {
        log(`Webhook ${incoming.url ?? ""} failed: ${String(error)}`);
        response = new Response(null, { status: 500 });
      }
      outgoing.writeHead(response.status, { "content-type": "text/plain" });
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : port,
        close: () => server.close(),
      });
    });
  });
}
