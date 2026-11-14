// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * Signed Linear webhooks the adapter can't use: "Send stop request" (a prompt
 * with the `stop` signal) interrupts the run instead of becoming a message, and
 * a new comment, which agent-sessions mode ignores, goes to `onComment`.
 * Anything else, and anything unsigned, goes to the adapter unchanged.
 */
import * as NodeCrypto from "node:crypto";

/** Linear refuses webhooks whose timestamp is further off than this, and so do we. */
const MAX_SKEW_MS = 60_000;

export interface LinearStop {
  readonly issueId: string;
  readonly sessionId: string;
  readonly userId: string;
}

/** A new comment on an issue by a person, as Linear's Comment webhook gives it. */
export interface LinearComment {
  readonly id: string;
  readonly issueId: string;
  readonly userId: string;
  readonly name: string;
  readonly body: string;
  /** The comment it replies to, if any. */
  readonly parentId?: string | undefined;
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

/** The new comment a body carries, if it is one by a person on an issue. Says nothing about the signature. */
export function commentOf(body: string): LinearComment | undefined {
  let payload: {
    readonly type?: string;
    readonly action?: string;
    readonly data?: {
      readonly id?: string;
      readonly issueId?: string | null;
      readonly userId?: string | null;
      readonly botActor?: unknown;
      readonly body?: string;
      readonly parentId?: string | null;
      readonly user?: { readonly name?: string } | null;
    };
  };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return undefined;
  }
  if (payload.type !== "Comment" || payload.action !== "create") return undefined;
  const data = payload.data;
  // Apps and integrations comment as bot actors; only people's comments are context.
  if (data?.botActor !== undefined && data.botActor !== null) return undefined;
  if (!data?.id || !data.issueId || !data.userId || typeof data.body !== "string") return undefined;
  return {
    id: data.id,
    issueId: data.issueId,
    userId: data.userId,
    name: data.user?.name ?? "",
    body: data.body,
    parentId: data.parentId ?? undefined,
  };
}

/**
 * Wraps the adapter's webhook handler: a signed stop interrupts the run
 * instead of becoming a prompt, and a signed new comment goes to `onComment`.
 */
export function handlingLinearEvents(
  handle: (request: Request) => Promise<Response>,
  options: {
    readonly secret: string;
    readonly onStop: (stop: LinearStop) => Promise<void>;
    /** Started, not awaited: Linear wants its answer within seconds. */
    readonly onComment?: (comment: LinearComment) => Promise<void>;
    readonly log: (line: string) => void;
    readonly now?: () => number;
  },
): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  return async (request) => {
    const body = await request.text();
    const stop = stopOf(body);
    const comment = stop === undefined ? commentOf(body) : undefined;
    const signed = () => isSignedByLinear(body, request.headers, options.secret, now());
    if (stop !== undefined && signed()) {
      options.log(`Linear: stop requested in session ${stop.sessionId} by ${stop.userId}.`);
      await options.onStop(stop);
      return new Response("OK");
    }
    if (comment !== undefined && options.onComment !== undefined && signed()) {
      void options
        .onComment(comment)
        .catch((error: unknown) =>
          options.log(`Linear: keeping comment ${comment.id} failed: ${String(error)}`),
        );
      return new Response("OK");
    }
    // The body was read; the adapter gets the same request again and checks its signature itself.
    return handle(
      new Request(request.url, { method: request.method, headers: request.headers, body }),
    );
  };
}
