/**
 * Client for the self-hosted Vexa meeting API (verified against Vexa v0.12.28,
 * commit f1a62fbbdfd2c98cb162582d82c31fe8102acc89). Contracts used:
 * `POST /bots`, `DELETE /bots/{platform}/{native_meeting_id}`,
 * `GET /meetings/{id}`, `GET /transcripts/by-id/{id}`, and the gateway `/ws`
 * multiplex, which forwards `tc:meeting:{id}:mutable` transcript bundles and
 * `bm:meeting:{id}:status` lifecycle frames verbatim.
 */
import { Option, Schema } from "effect";
import { ADMISSION_TIMEOUT_MS } from "./occurrence-machine.ts";

/**
 * Display name every participant sees. It states that the bot transcribes, and
 * it is a constant so a deployment cannot hide what the bot does.
 */
export const BOT_DISPLAY_NAME = "Standup Transcription Bot";

/** A stalled Vexa request must not hold up the scheduler's deadlines. */
const REQUEST_TIMEOUT_MS = 15_000;

const GOOGLE_MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** Returns the Meet code (`abc-defg-hij`) from a Google Meet join link. */
export function googleMeetCode(meetingUrl: string): string {
  const url = new URL(meetingUrl);
  const code = url.pathname.replace(/^\/+|\/+$/g, "");
  if (
    url.protocol !== "https:" ||
    url.hostname !== "meet.google.com" ||
    !GOOGLE_MEET_CODE.test(code)
  ) {
    throw new Error(`Not a Google Meet join link: ${meetingUrl}`);
  }
  return code;
}

const nullish = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));
const MeetingRef = Schema.Struct({ id: Schema.Int });

const VexaSegment = Schema.Struct({
  segment_id: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  speaker: nullish(Schema.String),
  speaker_key: nullish(Schema.String),
  text: nullish(Schema.String),
  start: Schema.Number,
  end: Schema.Number,
  language: nullish(Schema.String),
  completed: Schema.optional(Schema.Boolean),
  absolute_start_time: nullish(Schema.String),
  absolute_end_time: nullish(Schema.String),
  source: nullish(Schema.String),
});
export type VexaSegment = typeof VexaSegment.Type;

const LiveStatus = Schema.Literals([
  "requested",
  "joining",
  "awaiting_admission",
  "needs_help",
  "active",
  "stopping",
]);
const MeetingStatus = Schema.Union([LiveStatus, Schema.Literals(["completed", "failed"])]);
export type VexaMeetingStatus = typeof MeetingStatus.Type;

const VexaMeeting = Schema.Struct({
  id: Schema.Int,
  status: Schema.String,
  data: nullish(
    Schema.Struct({
      completion_reason: nullish(Schema.String),
      failure_stage: nullish(Schema.String),
    }),
  ),
});
export type VexaMeeting = typeof VexaMeeting.Type;

const VexaTranscript = Schema.Struct({
  id: Schema.Int,
  status: Schema.String,
  segments: Schema.Array(VexaSegment),
});

export type VexaFrame =
  | { type: "transcript"; meetingId: number; confirmed: ReadonlyArray<VexaSegment> }
  | { type: "transcript_retract"; meetingId: number; segmentIds: ReadonlyArray<string> }
  | { type: "status"; meetingId: number; status: VexaMeetingStatus }
  | { type: "subscribed" }
  | { type: "error"; error: string };

const WireFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("transcript"),
    meeting: MeetingRef,
    confirmed: Schema.optional(Schema.Array(VexaSegment)),
  }),
  Schema.Struct({
    type: Schema.Literal("transcript_retract"),
    meeting: MeetingRef,
    segment_ids: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("meeting.status"),
    meeting: Schema.optional(MeetingRef),
    meeting_id: Schema.optional(Schema.Int),
    payload: Schema.optional(Schema.Struct({ status: Schema.String })),
    status: nullish(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("subscribed") }),
  Schema.Struct({ type: Schema.Literal("error"), error: Schema.String }),
]);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeMeeting = Schema.decodeUnknownSync(VexaMeeting);
const decodeTranscript = Schema.decodeUnknownSync(VexaTranscript);
const decodeWireFrame = Schema.decodeUnknownOption(Schema.fromJsonString(WireFrame));
const decodeMeetingStatus = Schema.decodeUnknownOption(MeetingStatus);
const isLive = Schema.is(LiveStatus);

/** Parses one `/ws` frame. Frames this service does not use return `null`. */
export function parseVexaFrame(raw: string): VexaFrame | null {
  const parsed = decodeWireFrame(raw);
  if (Option.isNone(parsed)) return null;
  const frame = parsed.value;
  switch (frame.type) {
    case "transcript":
      return {
        type: "transcript",
        meetingId: frame.meeting.id,
        confirmed: (frame.confirmed ?? []).filter((segment) => segment.completed === true),
      };
    case "transcript_retract":
      return {
        type: "transcript_retract",
        meetingId: frame.meeting.id,
        segmentIds: frame.segment_ids,
      };
    case "meeting.status": {
      const meetingId = frame.meeting?.id ?? frame.meeting_id;
      const status = meetingStatus(frame.payload?.status ?? frame.status ?? "");
      if (meetingId === undefined || status === null) return null;
      return { type: "status", meetingId, status };
    }
    case "subscribed":
      return { type: "subscribed" };
    case "error":
      return { type: "error", error: frame.error };
  }
}

/** Vexa statuses this service acts on; planned-meeting statuses (`idle`, `scheduled`) return `null`. */
export function meetingStatus(value: string): VexaMeetingStatus | null {
  return Option.getOrNull(decodeMeetingStatus(value));
}

export function isLiveStatus(status: VexaMeetingStatus): status is typeof LiveStatus.Type {
  return isLive(status);
}

export class VexaRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "VexaRequestError";
    this.status = status;
  }
}

export type VexaClient = {
  requestBot(meetCode: string): Promise<VexaMeeting>;
  /** `absent` means Vexa has no running bot for this meeting. */
  stopBot(meetCode: string): Promise<"stopping" | "absent">;
  getMeeting(meetingId: number): Promise<VexaMeeting>;
  getConfirmedSegments(meetingId: number): Promise<VexaSegment[]>;
  streamUrl(): string;
  apiKey: string;
};

export function createVexaClient(options: {
  apiUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}): VexaClient {
  const base = options.apiUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        "X-API-Key": options.apiKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new VexaRequestError(
        response.status,
        `Vexa ${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return text ? decodeJson(text) : null;
  }

  return {
    apiKey: options.apiKey,
    async requestBot(meetCode) {
      return decodeMeeting(
        await call("POST", "/bots", {
          platform: "google_meet",
          native_meeting_id: meetCode,
          bot_name: BOT_DISPLAY_NAME,
          transcribe_enabled: true,
          // Phase 1 keeps transcripts only. No audio recording is stored.
          recording_enabled: false,
          automatic_leave: { max_wait_for_admission: ADMISSION_TIMEOUT_MS },
        }),
      );
    },
    async stopBot(meetCode) {
      try {
        await call("DELETE", `/bots/google_meet/${encodeURIComponent(meetCode)}`);
        return "stopping";
      } catch (error) {
        // 404 means no bot is running for this meeting, which is the goal.
        if (error instanceof VexaRequestError && error.status === 404) return "absent";
        throw error;
      }
    },
    async getMeeting(meetingId) {
      return decodeMeeting(await call("GET", `/meetings/${meetingId}`));
    },
    async getConfirmedSegments(meetingId) {
      const transcript = decodeTranscript(await call("GET", `/transcripts/by-id/${meetingId}`));
      return transcript.segments.filter((segment) => segment.completed !== false);
    },
    streamUrl() {
      const url = new URL(`${base}/ws`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.toString();
    },
  };
}
