import { z } from "zod";

export const slackMessage = z.object({
  ts: z.string(),
  text: z.string().optional(),
  thread_ts: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  reactions: z.array(z.object({ name: z.string(), count: z.number() })).optional(),
});
const responseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  ts: z.string().optional(),
  messages: z.array(slackMessage).optional(),
  has_more: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

export class SlackError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterMs = 0,
  ) {
    super(code);
  }
}

// Do not log response bodies or exceptions. Slack can echo message text.
export async function slackCall(
  token: string,
  method: string,
  args: Record<string, string | number | boolean>,
  timeoutMs = 10_000,
) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(args),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new SlackError(
      "rate_limited",
      Math.max(1, Number.isFinite(seconds) ? seconds : 1) * 1_000,
    );
  }
  if (!response.ok) throw new SlackError(`http_${response.status}`);
  const result = responseSchema.parse(await response.json());
  if (!result.ok) {
    const code = result.error ?? "unknown_error";
    // Only known-safe codes cross the logging boundary.
    throw new SlackError(/^[a-z_]+$/.test(code) ? code : "unknown_error");
  }
  return result;
}

export function slackText(text: string, conversationKey: string) {
  // Remove the header and any bare copy of this conversation's signed key.
  return text
    .replace(/<!--\s*t3_reply_key:[\s\S]*?-->/g, "")
    .split(`${conversationKey}.`)
    .map((part, index) => (index ? part.replace(/^[a-f0-9]{64}/i, "[redacted]") : part))
    .join("")
    .trim();
}
