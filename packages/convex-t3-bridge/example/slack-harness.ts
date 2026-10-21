import * as NodeURL from "node:url";
import { slackCall, SlackError, type slackMessage } from "./convex/slackApi.js";
import type { z } from "zod";

const TIMEOUT_MS = 5 * 60_000;
const TEST_CHANNEL = "C0AJ5HR70PR";
const checks = ["threaded answer", "eyes reaction", "thread follow-up"];
type Message = z.infer<typeof slackMessage>;

class CheckFailure extends Error {}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new CheckFailure(message);
}

export async function runSlackHarness(targetChannel = process.argv[2]) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_TEST_CHANNEL_ID;
  const prefix = process.env.SLACK_TRIGGER_PREFIX ?? "t3bridge:";
  try {
    check(token, "Missing SLACK_BOT_TOKEN.");
    check(channel === TEST_CHANNEL, "SLACK_TEST_CHANNEL_ID must be the shared #testing channel.");
    check(!targetChannel || targetChannel === channel, "Channel override refused.");
    check(prefix.length > 0, "SLACK_TRIGGER_PREFIX must not be empty.");
  } catch (error) {
    for (const name of checks) {
      console.log(
        `FAIL ${name}: ${error instanceof CheckFailure ? error.message : "Invalid configuration."}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  let deadline = Date.now() + TIMEOUT_MS;
  let threadTs: string | undefined;
  let firstAnswer = false;

  async function request(method: string, args: Record<string, string | boolean | number>) {
    check(token, "Missing SLACK_BOT_TOKEN.");
    while (Date.now() < deadline) {
      try {
        return await slackCall(
          token,
          method,
          args,
          Math.max(1, Math.min(10_000, deadline - Date.now())),
        );
      } catch (error) {
        if (!(error instanceof SlackError) || !error.retryAfterMs) throw error;
        check(Date.now() + error.retryAfterMs < deadline, "Rate limit exceeds check deadline.");
        await new Promise((resolve) => setTimeout(resolve, error.retryAfterMs));
      }
    }
    throw new CheckFailure("Check deadline exceeded.");
  }

  async function scenario(name: string, run: () => Promise<void>) {
    deadline = Date.now() + TIMEOUT_MS;
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      // Never print remote exceptions, message text, or either kind of token.
      console.log(
        `FAIL ${name}: ${error instanceof CheckFailure ? error.message : "Slack request failed."}`,
      );
      process.exitCode = 1;
    }
  }

  async function waitFor(predicate: (messages: Message[]) => boolean) {
    check(threadTs, "The first trigger must be posted before this check.");
    while (Date.now() < deadline) {
      const messages: Message[] = [];
      let cursor = "";
      do {
        const page = await request("conversations.replies", {
          channel: TEST_CHANNEL,
          ts: threadTs,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        messages.push(...(page.messages ?? []));
        const next = page.response_metadata?.next_cursor ?? "";
        check(!page.has_more || (next && next !== cursor), "Slack pagination did not advance.");
        cursor = next;
      } while (cursor && Date.now() < deadline);
      if (predicate(messages)) return;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(3_000, Math.max(0, deadline - Date.now()))),
      );
    }
    throw new CheckFailure("Check deadline exceeded.");
  }

  await scenario("threaded answer", async () => {
    const expected = `slack-ok-${crypto.randomUUID()}`;
    const sent = await request("chat.postMessage", {
      channel: TEST_CHANNEL,
      text: `${prefix} Reply with exactly: ${expected}`,
      unfurl_links: false,
      unfurl_media: false,
    });
    check(sent.ts, "Slack did not return the trigger timestamp.");
    threadTs = sent.ts;
    await waitFor((messages) =>
      messages.some(
        (message) =>
          message.ts !== threadTs &&
          message.thread_ts === threadTs &&
          message.bot_id &&
          !message.text?.startsWith("Working:") &&
          message.text?.includes(expected),
      ),
    );
    firstAnswer = true;
  });
  await scenario("eyes reaction", async () => {
    await waitFor((messages) =>
      messages.some(
        (message) =>
          message.ts === threadTs &&
          message.reactions?.some((reaction) => reaction.name === "eyes" && reaction.count > 0),
      ),
    );
  });
  await scenario("thread follow-up", async () => {
    check(firstAnswer && threadTs, "The first answer must pass before the follow-up.");
    const expected = `slack-ok-${crypto.randomUUID()}`;
    const sent = await request("chat.postMessage", {
      channel: TEST_CHANNEL,
      thread_ts: threadTs,
      text: `${prefix} Reply with exactly: ${expected}`,
      unfurl_links: false,
      unfurl_media: false,
    });
    check(sent.ts, "Slack did not return the follow-up timestamp.");
    await waitFor((messages) =>
      messages.some(
        (message) =>
          Number(message.ts) > Number(sent.ts) &&
          message.thread_ts === threadTs &&
          message.bot_id &&
          !message.text?.startsWith("Working:") &&
          message.text?.includes(expected),
      ),
    );
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  await runSlackHarness();
}
