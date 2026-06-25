import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { Message, Thread } from "chat";

import {
  canonicalSlackChatThreadId,
  slackConversationKind,
  uploadSlackFiles,
} from "./ExternalChat.ts";
import { stripSlackClientAttribution } from "./slack.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("uploadSlackFiles", () => {
  it("uses form-encoded Slack API requests for external uploads", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    globalThis.fetch = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes("files.getUploadURLExternal")) {
          expect(init?.headers).toMatchObject({
            "Content-Type": "application/x-www-form-urlencoded",
          });
          expect(init?.body).toBeInstanceOf(URLSearchParams);
          const form = init?.body as URLSearchParams;
          expect(form.get("filename")).toBe("restaurants.csv");
          expect(form.get("length")).toBe("7");
          return new Response(
            JSON.stringify({
              ok: true,
              file_id: "F123",
              upload_url: "https://files.slack.test/upload",
            }),
          );
        }
        if (url === "https://files.slack.test/upload") {
          expect(init?.method).toBe("POST");
          expect(init?.headers).toMatchObject({ "Content-Type": "text/csv" });
          return new Response("");
        }
        if (url.includes("files.completeUploadExternal")) {
          expect(init?.headers).toMatchObject({
            "Content-Type": "application/x-www-form-urlencoded",
          });
          expect(init?.body).toBeInstanceOf(URLSearchParams);
          const form = init?.body as URLSearchParams;
          expect(JSON.parse(form.get("files") ?? "[]")).toEqual([
            { id: "F123", title: "restaurants.csv" },
          ]);
          expect(form.get("channel_id")).toBe("C123");
          expect(form.get("thread_ts")).toBe("1781138017.962159");
          expect(form.get("initial_comment")).toBe("Agent response with CSV attached.");
          return new Response(JSON.stringify({ ok: true }));
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    ) as unknown as typeof fetch;

    await expect(
      uploadSlackFiles({
        token: "xoxb-test",
        channelId: "C123",
        threadTs: "1781138017.962159",
        files: [
          {
            name: "restaurants.csv",
            mimeType: "text/csv",
            data: new TextEncoder().encode("a,b\n1,2"),
          },
        ],
        initialComment: "Agent response with CSV attached.",
      }),
    ).resolves.toEqual(["F123"]);

    expect(calls.map((call) => call.url)).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.slack.test/upload",
      "https://slack.com/api/files.completeUploadExternal",
    ]);
  });
});

describe("slackConversationKind", () => {
  it("detects one-to-one DMs from Slack channel_type", () => {
    expect(
      slackConversationKind({
        channelId: "D123",
        raw: { channel_type: "im" },
      }),
    ).toBe("dm");
  });

  it("falls back to D-prefixed Slack conversation ids for DMs", () => {
    expect(slackConversationKind({ channelId: "D123" })).toBe("dm");
  });

  it("keeps public and private channel events as channel intake", () => {
    expect(
      slackConversationKind({
        channelId: "C123",
        raw: { channel_type: "channel" },
      }),
    ).toBe("channel");
    expect(slackConversationKind({ channelId: "G123" })).toBe("channel");
  });

  it("detects multi-party DMs only when Slack identifies the event as mpim", () => {
    expect(
      slackConversationKind({
        channelId: "G123",
        raw: { channel_type: "mpim" },
      }),
    ).toBe("mpim");
  });
});

describe("stripSlackClientAttribution", () => {
  it("removes plain ChatGPT client attribution", () => {
    expect(
      stripSlackClientAttribution("confirm u can make spreadsheets\n*Sent using* ChatGPT"),
    ).toBe("confirm u can make spreadsheets");
  });

  it("removes Slack mention-form ChatGPT client attribution", () => {
    expect(
      stripSlackClientAttribution(
        "confirm u can make spreadsheets\n*Sent using* <@U0BC8FXNJG0|ChatGPT>",
      ),
    ).toBe("confirm u can make spreadsheets");
  });
});

describe("canonicalSlackChatThreadId", () => {
  it("uses the incoming message timestamp for top-level Slack DMs", () => {
    expect(
      canonicalSlackChatThreadId(
        { id: "slack:D123:", channelId: "slack:D123" } as Thread,
        {
          id: "1781138017.962159",
          raw: {
            channel: "D123",
            channel_type: "im",
            ts: "1781138017.962159",
            text: "please fix this",
          },
        } as Message,
      ),
    ).toBe("slack:D123:1781138017.962159");
  });

  it("keeps Slack DM replies attached to their parent thread timestamp", () => {
    expect(
      canonicalSlackChatThreadId(
        { id: "slack:D123:1781138017.962159", channelId: "slack:D123" } as Thread,
        {
          id: "1781138111.000200",
          raw: {
            channel: "D123",
            channel_type: "im",
            thread_ts: "1781138017.962159",
            ts: "1781138111.000200",
            text: "follow-up",
          },
        } as Message,
      ),
    ).toBe("slack:D123:1781138017.962159");
  });
});
