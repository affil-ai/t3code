// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * Signs the bridge in to T3 with T3's MCP OAuth flow, the one Claude and
 * Codex use to connect to T3. You approve it in T3 and choose its access
 * level there; T3 caps every thread the bridge starts at that level.
 *
 * T3 issues no refresh tokens, so the login lasts as long as T3's MCP
 * sessions (30 days) and then needs running again.
 */
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const CALLBACK_PATH = "/callback";

interface SavedLogin {
  readonly t3Url: string;
  readonly accessToken: string;
}

const loginFile = (dir: string) => NodePath.join(dir, "t3-login.json");

/** The saved token for `t3Url`, if the last login was to that server. */
export function savedToken(dir: string, t3Url: string): string | undefined {
  try {
    const saved = JSON.parse(NodeFS.readFileSync(loginFile(dir), "utf8")) as SavedLogin;
    return new URL(saved.t3Url).origin === new URL(t3Url).origin ? saved.accessToken : undefined;
  } catch {
    return undefined;
  }
}

function saveLogin(dir: string, login: SavedLogin): void {
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = loginFile(dir);
  NodeFS.writeFileSync(file, JSON.stringify(login), { mode: 0o600 });
  NodeFS.chmodSync(file, 0o600);
}

export async function login(options: {
  readonly t3Url: string;
  readonly dataDir: string;
  readonly callbackPort: number;
  readonly print: (line: string) => void;
}): Promise<void> {
  const redirectUrl = `http://127.0.0.1:${options.callbackPort}${CALLBACK_PATH}`;
  let clientInformation: OAuthClientInformationMixed | undefined;
  let verifier = "";
  let tokens: OAuthTokens | undefined;

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "T3 chat bridge",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => clientInformation,
    saveClientInformation: (info) => {
      clientInformation = info;
    },
    tokens: () => tokens,
    saveTokens: (next) => {
      tokens = next;
    },
    redirectToAuthorization: (url) => {
      options.print("Open this link in a browser signed in to T3, and approve the bridge:");
      options.print("");
      options.print(`  ${url.toString()}`);
      options.print("");
      options.print(`Waiting for T3 to redirect to ${redirectUrl} ...`);
    },
    saveCodeVerifier: (next) => {
      verifier = next;
    },
    codeVerifier: () => verifier,
  };

  const code = new Promise<string>((resolve, reject) => {
    const server = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", redirectUrl);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }
      const value = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      response
        .writeHead(200, { "content-type": "text/plain; charset=utf-8" })
        .end(value ? "The bridge is signed in to T3. You can close this tab." : "Sign-in failed.");
      server.close();
      if (value) resolve(value);
      else reject(new Error(`T3 did not approve the login: ${error ?? "no code"}`));
    });
    server.once("error", reject);
    server.listen(options.callbackPort, "127.0.0.1");
  });

  const serverUrl = new URL("/mcp", options.t3Url);
  const first = await auth(provider, { serverUrl });
  if (first !== "AUTHORIZED") {
    const second = await auth(provider, { serverUrl, authorizationCode: await code });
    if (second !== "AUTHORIZED") throw new Error("T3 did not issue a token.");
  }
  if (tokens === undefined) throw new Error("T3 did not issue a token.");
  saveLogin(options.dataDir, { t3Url: options.t3Url, accessToken: tokens.access_token });
  options.print(`Signed in. Saved to ${loginFile(options.dataDir)}.`);
}
