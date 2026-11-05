// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * Linear's "Send stop request" arrives as a prompt carrying the `stop` signal,
 * which the adapter would hand over as an ordinary message. This catches a
 * signed stop first and interrupts the issue's run instead; anything else,
 * including a stop that isn't signed, goes to the adapter unchanged.
 */
import * as NodeCrypto from "node:crypto";

/** Linear refuses webhooks whose timestamp is further off than this, and so do we. */
const MAX_SKEW_MS = 60_000;

export interface LinearStop {
  readonly issueId: string;
  readonly sessionId: string;
  readonly userId: string;
}

/** True when Linear signed this body with the secret, within the timestamp window. */
export function isSignedByLinear(
  body: string,
  headers: Headers,
  secret: string,
  now: number,
): boolean {
  const signature = headers.get("linear-signature") ?? "";
  const expected = NodeCrypto.createHmac("sha256", secret).update(body).digest("hex");
  if (
    signature.length !== expected.length ||
    !NodeCrypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return false;
  }
  let timestamp = Number(headers.get("linear-timestamp") ?? Number.NaN);
  if (Number.isNaN(timestamp)) {
    try {
      timestamp = Number((JSON.parse(body) as { webhookTimestamp?: unknown }).webhookTimestamp);
    } catch {
      return false;
    }
  }
  return !Number.isNaN(timestamp) && Math.abs(now - timestamp) <= MAX_SKEW_MS;
}

/** The stop a body carries, if it is one. Says nothing about whether Linear signed it. */
export function stopOf(body: string): LinearStop | undefined {
  let payload: {
    readonly type?: string;
    readonly action?: string;
    readonly agentSession?: {
      readonly id?: string;
      readonly issueId?: string;
      readonly issue?: { readonly id?: string };
      readonly creatorId?: string;
    };
    readonly agentActivity?: { readonly signal?: string; readonly user?: { readonly id?: string } };
  };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return undefined;
  }
  if (payload.type !== "AgentSessionEvent" || payload.action !== "prompted") return undefined;
  if (payload.agentActivity?.signal !== "stop") return undefined;
  const session = payload.agentSession;
  const issueId = session?.issueId ?? session?.issue?.id;
  const userId = payload.agentActivity.user?.id ?? session?.creatorId;
  if (session?.id === undefined || issueId === undefined || userId === undefined) return undefined;
  return { issueId, sessionId: session.id, userId };
}

/** Wraps the adapter's webhook handler so a signed stop interrupts the run instead of becoming a prompt. */
export function handlingStops(
  handle: (request: Request) => Promise<Response>,
  options: {
    readonly secret: string;
    readonly onStop: (stop: LinearStop) => Promise<void>;
    readonly log: (line: string) => void;
    readonly now?: () => number;
  },
): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  return async (request) => {
    const body = await request.text();
    const stop = stopOf(body);
    if (stop !== undefined && isSignedByLinear(body, request.headers, options.secret, now())) {
      options.log(`Linear: stop requested in session ${stop.sessionId} by ${stop.userId}.`);
      await options.onStop(stop);
      return new Response("OK");
    }
    // The body was read; the adapter gets the same request again and checks its signature itself.
    return handle(
      new Request(request.url, { method: request.method, headers: request.headers, body }),
    );
  };
}
