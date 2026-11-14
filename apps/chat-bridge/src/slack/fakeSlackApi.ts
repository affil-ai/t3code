// @effect-diagnostics nodeBuiltinImport:off -- A test stand-in for Slack's Web API; it does not use Effect.
/**
 * Slack's Web API on loopback, for tests: each method answers from a handler,
 * and every call is recorded with its arguments. A method without a handler
 * answers `unknown_method`, as Slack does.
 */
import * as NodeHttp from "node:http";

export type SlackMethodHandler = (
  args: Record<string, string>,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export async function fakeSlackApi(handlers: Readonly<Record<string, SlackMethodHandler>>) {
  const calls: Array<{ readonly method: string; readonly args: Record<string, string> }> = [];
  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const method = (request.url ?? "").replace(/^\/api\//, "").split("?")[0]!;
      const args = request.headers["content-type"]?.includes("json")
        ? (JSON.parse(body || "{}") as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(body));
      delete args.token;
      calls.push({ method, args });
      const handler = handlers[method];
      const result = handler ? await handler(args) : { ok: false, error: "unknown_method" };
      response.setHeader("content-type", "application/json");
      response.setHeader("connection", "close");
      response.end(JSON.stringify(result));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    apiUrl: `http://127.0.0.1:${port}/api/`,
    calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
