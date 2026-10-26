/**
 * Contract tests against Vexa v0.12.28 golden fixtures (commit
 * f1a62fbbdfd2c98cb162582d82c31fe8102acc89, Apache-2.0), copied unchanged from
 * core/meetings/contracts/transcript.v1/golden and
 * core/gateway/contracts/api.v1/golden. A live Vexa could not run on the
 * development host, so these fixtures stand in for the wire.
 */
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { ADMISSION_TIMEOUT_MS } from "./occurrence-machine.ts";
import { BOT_DISPLAY_NAME, createVexaClient, googleMeetCode, parseVexaFrame } from "./vexa.ts";

const fixture = (name: string) =>
  NodeFS.readFileSync(new URL(`./__fixtures__/vexa-v0.12.28/${name}`, import.meta.url), "utf8");

describe("Vexa /ws frames", () => {
  it("keeps only confirmed segments from a live transcript bundle", () => {
    expect(parseVexaFrame(fixture("MutableBundle.live.json"))).toEqual({
      type: "transcript",
      meetingId: 42,
      confirmed: [
        {
          segment_id: "sess-uid:ch-0:1:1500",
          speaker: "Alice",
          speaker_key: "ch-0:1",
          text: "hello world",
          start: 1.5,
          end: 2.5,
          completed: true,
        },
      ],
    });
  });

  it("reads both meeting.status frame shapes the gateway forwards", () => {
    const perMeeting = JSON.stringify({
      type: "meeting.status",
      meeting: { id: 42, platform: "google_meet", native_id: "abc-defg-hij" },
      payload: { status: "awaiting_admission" },
      user_id: 7,
      ts: "2026-10-20T16:29:00Z",
    });
    const perUser = JSON.stringify({
      type: "meeting.status",
      meeting_id: 42,
      native: "abc-defg-hij",
      status: "active",
    });
    expect(parseVexaFrame(perMeeting)).toEqual({
      type: "status",
      meetingId: 42,
      status: "awaiting_admission",
    });
    expect(parseVexaFrame(perUser)).toEqual({ type: "status", meetingId: 42, status: "active" });
    expect(
      parseVexaFrame(
        JSON.stringify({ type: "meeting.status", meeting_id: 42, status: "scheduled" }),
      ),
    ).toBeNull();
  });

  it("reads retractions and ignores frames it does not use", () => {
    expect(
      parseVexaFrame(
        JSON.stringify({ type: "transcript_retract", meeting: { id: 42 }, segment_ids: ["a"] }),
      ),
    ).toEqual({ type: "transcript_retract", meetingId: 42, segmentIds: ["a"] });
    expect(parseVexaFrame(JSON.stringify({ type: "pong" }))).toBeNull();
    expect(parseVexaFrame("not json")).toBeNull();
  });
});

describe("Vexa REST client", () => {
  function recordingFetch(responses: Response[]) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fake: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    };
    return { calls, fetch: fake };
  }

  it("sends a visibly named, transcription-only bot that waits for host admission", async () => {
    const { calls, fetch } = recordingFetch([
      new Response(fixture("MeetingResponse.example.json"), { status: 201 }),
    ]);
    const client = createVexaClient({
      apiUrl: "http://vexa.local:8056/",
      apiKey: "test-key",
      fetch,
    });

    const meeting = await client.requestBot("abc-defg-hij");

    expect(meeting).toMatchObject({ id: 42, status: "active" });
    expect(calls[0]?.url).toBe("http://vexa.local:8056/bots");
    expect(new Headers(calls[0]?.init?.headers).get("X-API-Key")).toBe("test-key");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      platform: "google_meet",
      native_meeting_id: "abc-defg-hij",
      bot_name: BOT_DISPLAY_NAME,
      transcribe_enabled: true,
      recording_enabled: false,
      automatic_leave: { max_wait_for_admission: ADMISSION_TIMEOUT_MS },
    });
    expect(BOT_DISPLAY_NAME).toMatch(/transcription bot/i);
  });

  it("treats stopping a bot that is already gone as success and surfaces other failures", async () => {
    const { calls, fetch } = recordingFetch([
      new Response("{}", { status: 404 }),
      new Response("boom", { status: 500 }),
    ]);
    const client = createVexaClient({ apiUrl: "http://vexa.local:8056", apiKey: "k", fetch });
    await expect(client.stopBot("abc-defg-hij")).resolves.toBe("absent");
    await expect(client.stopBot("abc-defg-hij")).rejects.toThrow(/500/);
    expect(calls[0]).toMatchObject({
      url: "http://vexa.local:8056/bots/google_meet/abc-defg-hij",
      init: { method: "DELETE" },
    });
  });

  it("derives the WebSocket URL from the gateway URL", () => {
    expect(createVexaClient({ apiUrl: "https://vexa.example.com", apiKey: "k" }).streamUrl()).toBe(
      "wss://vexa.example.com/ws",
    );
  });
});

describe("googleMeetCode", () => {
  it("accepts Google Meet join links only", () => {
    expect(googleMeetCode("https://meet.google.com/abc-defg-hij?authuser=0")).toBe("abc-defg-hij");
    expect(() => googleMeetCode("https://meet.google.com.evil.test/abc-defg-hij")).toThrow();
    expect(() => googleMeetCode("https://zoom.us/j/123")).toThrow();
  });
});
