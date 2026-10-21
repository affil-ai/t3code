import * as NodeURL from "node:url";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { z } from "zod";
import { api } from "./convex/_generated/api.js";

type Events = FunctionReturnType<typeof api.t3.listEvents>;
type Event = Events[number]["payload"];
const TURN_TIMEOUT = 5 * 60_000;
const CANCEL_TIMEOUT = 60_000;
const REQUEST_TIMEOUT = 10_000;
const scenarios = ["launch round trip", "follow-up", "reply route", "cancel"];
const rpcResponse = z.object({
  result: z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.unknown().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    })
    .optional(),
  error: z.unknown().optional(),
});
const threadPage = z.object({
  items: z.array(z.object({ type: z.string(), text: z.string().nullable() })),
  hasMore: z.boolean(),
  nextPosition: z.number().nullable(),
});

class CheckFailure extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailure(message);
}

function requiredEnv(name: string) {
  const value = process.env[name];
  check(value, `Missing ${name}.`);
  return value;
}

function localUrl(value: string) {
  const url = new URL(value);
  check(
    url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "This harness only runs against a local Convex deployment.",
  );
  return url;
}

// Every fetch is bounded by the enclosing scenario's deadline.
function timeoutFetch(deadline: () => number): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT, deadline() - Date.now()))),
    });
}

export async function runHarness() {
  let client: ConvexHttpClient;
  let t3Token: string;
  let replyToken: string;
  let t3Url: string;
  let replyUrl: URL;
  let deadline = Date.now() + TURN_TIMEOUT;
  try {
    const url = localUrl(requiredEnv("CONVEX_URL"));
    const site = localUrl(requiredEnv("CONVEX_SITE_URL"));
    replyUrl = new URL("/t3-reply", site);
    t3Url = requiredEnv("T3_MCP_URL");
    t3Token = requiredEnv("T3_MCP_TOKEN");
    replyToken = requiredEnv("T3_BRIDGE_MCP_TOKEN");
    client = new ConvexHttpClient(url.origin, {
      logger: false,
      fetch: timeoutFetch(() => deadline),
    });
  } catch (error) {
    for (const name of scenarios)
      console.log(
        `FAIL ${name}: ${error instanceof CheckFailure ? error.message : "Invalid configuration."}`,
      );
    process.exitCode = 1;
    return;
  }

  const request = timeoutFetch(() => deadline);
  const conversationKey = `bridge-test:${crypto.randomUUID()}`;
  const cancelKey = `bridge-cancel:${crypto.randomUUID()}`;
  let threadId: string | undefined;
  let launchPassed = false;
  let requestId = 0;
  let sessionId: string | undefined;

  async function scenario(name: string, run: () => Promise<void>) {
    deadline = Date.now() + TURN_TIMEOUT;
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      // Remote exceptions may echo arguments, routing keys, or credentials.
      const message =
        error instanceof CheckFailure
          ? error.message
          : "Request failed, inspect local deployment logs.";
      console.log(`FAIL ${name}: ${message}`);
      process.exitCode = 1;
    }
  }

  async function poll(key: string, predicate: (events: Event[]) => boolean) {
    while (Date.now() < deadline) {
      const events = (await client.query(api.t3.listEvents, { conversationKey: key })).map(
        (row) => row.payload,
      );
      const failure = events.find(
        (event) => event.type === "deliveryFailed" || event.type === "watchFailed",
      );
      check(!failure, `Component emitted ${failure?.type}.`);
      if (predicate(events)) return events;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(1_000, Math.max(0, deadline - Date.now()))),
      );
    }
    throw new CheckFailure("Event deadline exceeded.");
  }

  async function roundTrip() {
    const before = await client.query(api.t3.listEvents, { conversationKey });
    const previousRuns = new Set(
      before.flatMap(({ payload }) => (payload.type === "turnStarted" ? [payload.runId] : [])),
    );
    const token = `bridge-ok-${crypto.randomUUID()}`;
    await client.mutation(api.t3.sendMessage, {
      conversationKey,
      text: `Reply with exactly: ${token}`,
    });
    const events = await poll(conversationKey, (current) =>
      current.some((event) => event.type === "turnEnded" && !previousRuns.has(event.runId)),
    );
    const startIndex = events.findIndex(
      (event) => event.type === "turnStarted" && !previousRuns.has(event.runId),
    );
    const started = events[startIndex];
    check(
      started?.type === "turnStarted" && started.origin === "send",
      "Missing send-origin turnStarted.",
    );
    const endIndex = events.findIndex(
      (event) => event.type === "turnEnded" && event.runId === started.runId,
    );
    const ended = events[endIndex];
    check(ended?.type === "turnEnded" && ended.status === "completed", "Turn did not complete.");
    check(endIndex > startIndex, "turnEnded preceded turnStarted.");
    check(
      ended.finalText.includes(token) ||
        events
          .slice(startIndex + 1, endIndex)
          .some(
            (event) =>
              event.type === "assistantMessage" &&
              event.runId === started.runId &&
              event.text.includes(token),
          ),
      "The run's assistantMessage or finalText did not contain the expected token.",
    );
    const conversation = await client.query(api.t3.getConversation, { conversationKey });
    check(conversation?.threadId === started.threadId, "Conversation thread mapping is wrong.");
    if (threadId) check(started.threadId === threadId, "Follow-up launched a different thread.");
    threadId = started.threadId;
  }

  async function mcpPost(body: Record<string, unknown>) {
    const response = await request(t3Url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${t3Token}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
    check(response.ok, `T3 MCP returned HTTP ${response.status}.`);
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const text = (await response.text()).trim();
    if (!text) return {};
    const json = text.startsWith("{")
      ? text
      : text
          .split(/\r?\n/)
          .findLast((line) => line.startsWith("data:") && line.slice(5).trim().startsWith("{"))
          ?.slice(5);
    check(json, "T3 MCP returned no JSON response.");
    const result = rpcResponse.parse(JSON.parse(json));
    check(!result.error && !result.result?.isError, "T3 MCP rejected the request.");
    return result;
  }

  async function readReplyKey() {
    check(threadId, "Launch must pass before the reply test.");
    await mcpPost({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "bridge-harness", version: "0.1.0" },
      },
    });
    await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    let position = 0;
    while (Date.now() < deadline) {
      const rpc = await mcpPost({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: {
          name: "t3_thread_read",
          arguments: {
            threadId,
            view: "messages",
            afterPosition: position,
            limit: 100,
            maxCharsPerItem: 4_000,
          },
        },
      });
      const result = rpc.result;
      const content = result?.content?.find((item) => item.type === "text")?.text;
      const page = threadPage.parse(
        result?.structuredContent ?? (content ? JSON.parse(content) : undefined),
      );
      const firstUserMessage = page.items.find((item) => item.type === "user_message");
      if (firstUserMessage) {
        const key = firstUserMessage.text?.match(/<!-- t3_reply_key: ([^\s]+) -->/)?.[1];
        check(
          key && key.startsWith(`${conversationKey}.`),
          "First user message has no matching routing key.",
        );
        return key;
      }
      check(
        page.hasMore && page.nextPosition !== null && page.nextPosition > position,
        "No first user message found.",
      );
      position = page.nextPosition;
    }
    throw new CheckFailure("Reply-key lookup deadline exceeded.");
  }

  async function postReply(key: string, text: string, authorized: boolean) {
    return request(replyUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: `Bearer ${replyToken}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name: "reply", arguments: { reply_key: key, text } },
      }),
    });
  }

  await scenario("launch round trip", async () => {
    await roundTrip();
    launchPassed = true;
  });
  await scenario("follow-up", async () => {
    check(launchPassed, "Launch must pass before the follow-up test.");
    await roundTrip();
  });
  await scenario("reply route", async () => {
    check(launchPassed, "Launch must pass before the reply test.");
    const key = await readReplyKey();
    const text = `bridge-reply-${crypto.randomUUID()}`;
    const accepted = await postReply(key, text, true);
    check(accepted.ok, `Reply returned HTTP ${accepted.status}.`);
    const acceptedBody = rpcResponse.parse(await accepted.json());
    check(
      acceptedBody.result && !acceptedBody.result.isError && !acceptedBody.error,
      "Reply was rejected.",
    );
    await poll(conversationKey, (events) =>
      events.some((event) => event.type === "reply" && event.text === text),
    );
    const duplicate = await postReply(key, text, true);
    check(duplicate.ok, `Duplicate reply returned HTTP ${duplicate.status}.`);
    const duplicateBody = rpcResponse.parse(await duplicate.json());
    check(
      duplicateBody.result?.isError &&
        duplicateBody.result.content?.some((item) => item.text === "T3_BRIDGE_REPLY_DUPLICATE"),
      "Duplicate reply was not rejected as a duplicate.",
    );
    const unauthorized = await postReply(key, `unauthorized-${crypto.randomUUID()}`, false);
    check(unauthorized.status === 401, "Missing bearer token did not return 401.");
    const events = await client.query(api.t3.listEvents, { conversationKey });
    check(
      events.filter(({ payload }) => payload.type === "reply" && payload.text === text).length ===
        1,
      "Duplicate reply created another event.",
    );
  });
  await scenario("cancel", async () => {
    await client.mutation(api.t3.sendMessage, {
      conversationKey: cancelKey,
      text: "Count slowly to 200, one number per line, using a shell sleep of 1s between numbers.",
    });
    const events = await poll(cancelKey, (current) =>
      current.some((event) => event.type === "turnStarted"),
    );
    const started = events.find((event) => event.type === "turnStarted");
    check(
      started?.type === "turnStarted" && started.origin === "send",
      "Cancel task did not start from send.",
    );
    deadline = Date.now() + CANCEL_TIMEOUT;
    await client.mutation(api.t3.cancel, { conversationKey: cancelKey });
    const finished = await poll(cancelKey, (current) =>
      current.some((event) => event.type === "turnEnded" && event.runId === started.runId),
    );
    const ended = finished.find(
      (event) => event.type === "turnEnded" && event.runId === started.runId,
    );
    check(
      ended?.type === "turnEnded" && ["interrupted", "cancelled"].includes(ended.status),
      "Cancel did not end the same run as interrupted or cancelled.",
    );
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  await runHarness();
}
