import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  ADMISSION_BACKSTOP_MS,
  LEAVE_CONFIRMATION_MS,
  MAX_ACTIVE_MS,
} from "./occurrence-machine.ts";
import { createStandupService, type OpenMeetingStream } from "./service.ts";
import { createStore, type Occurrence, type StandupStore } from "./store.ts";
import type { VexaClient, VexaFrame, VexaMeeting, VexaSegment } from "./vexa.ts";

// Monday 09:30 in Los Angeles, after the series rows below are created.
const start = new Date("2027-01-04T17:30:00Z");
const at = (ms: number) => new Date(start.getTime() + ms);

/** In-memory stand-in for the Vexa meeting API at its HTTP boundary. */
class FakeVexa implements VexaClient {
  apiKey = "test";
  meeting: VexaMeeting = { id: 42, status: "requested", data: null };
  segments: VexaSegment[] = [];
  botRequests = 0;
  stops = 0;
  failStops = 0;
  botRunning = false;
  /** Runs while POST /bots is in flight, before the bot exists. */
  duringRequest: (() => Promise<void>) | null = null;
  failStatusReads = false;
  failSegmentReads = false;
  async requestBot() {
    this.botRequests++;
    await this.duringRequest?.();
    this.botRunning = true;
    return this.meeting;
  }
  async stopBot(): Promise<"stopping" | "absent"> {
    this.stops++;
    if (this.failStops > 0) {
      this.failStops--;
      throw new Error("Vexa DELETE failed");
    }
    const result = this.botRunning ? "stopping" : "absent";
    this.botRunning = false;
    return result;
  }
  async getMeeting() {
    if (this.failStatusReads) throw new Error("Vexa GET failed");
    return this.meeting;
  }
  async getConfirmedSegments() {
    if (this.failSegmentReads) throw new Error("Vexa transcript read failed");
    return this.segments;
  }
  streamUrl() {
    return "ws://vexa.test/ws";
  }
}

let store: StandupStore;
let vexa: FakeVexa;
let now: Date;
let emit: (frame: VexaFrame) => void;
let reported: { operation: string; status?: unknown }[];

const openStream: OpenMeetingStream = ({ onFrame }) => {
  emit = onFrame;
  return { close() {} };
};

function service(overrides: Partial<StandupStore> = {}) {
  return createStandupService({
    store: { ...store, ...overrides },
    vexa,
    openStream,
    reportFailure: ({ operation, properties }) =>
      reported.push({ operation, status: properties?.status }),
    now: () => now,
  });
}

async function only(): Promise<Occurrence> {
  const [occurrence] = await store.listRecentOccurrences(1);
  if (!occurrence) throw new Error("no occurrence");
  return occurrence;
}

/** Requests the bot at T-90s and reports it admitted at T+0. */
async function admitted(bot: ReturnType<typeof service>) {
  now = at(-90_000);
  await bot.tick();
  vexa.meeting = { ...vexa.meeting, status: "active" };
  now = at(0);
  await bot.tick();
  return only();
}

const segment = (id: string, text: string): VexaSegment => ({
  segment_id: id,
  speaker: "Alice",
  text,
  start: 3,
  end: 5,
  completed: true,
});

beforeEach(async () => {
  store = createStore(new PGlite());
  await store.migrate();
  await store.addSeries({
    name: "Engineering standup",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    meetCode: "abc-defg-hij",
    schedule: { weekdays: ["mon"], startTime: "09:30", timeZone: "America/Los_Angeles" },
  });
  vexa = new FakeVexa();
  reported = [];
});

describe("standup service", () => {
  it("requests one bot per occurrence ninety seconds before the start", async () => {
    const bot = service();
    now = at(-120_000);
    await bot.tick();
    expect(vexa.botRequests).toBe(0);

    now = at(-90_000);
    await bot.tick();
    now = at(-75_000);
    await bot.tick();
    expect(vexa.botRequests).toBe(1);
    expect(await only()).toMatchObject({
      status: "requested",
      vexaMeetingId: 42,
      scheduledStart: start,
    });
  });

  it("persists live confirmed segments for this bot's meeting only", async () => {
    const bot = service();
    const occurrence = await admitted(bot);
    emit({ type: "transcript", meetingId: 41, confirmed: [segment("old-standup", "Yesterday")] });
    emit({ type: "transcript", meetingId: 42, confirmed: [segment("s1", "Shipped the fix")] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await store.listSegments(occurrence.id)).map((row) => row.segmentId)).toEqual(["s1"]);
  });

  it("backfills confirmed segments from REST while active, in case stream frames were missed", async () => {
    const bot = service();
    vexa.segments = [segment("s2", "Deploying today")];
    const occurrence = await admitted(bot);
    expect((await store.listSegments(occurrence.id)).map((row) => row.text)).toEqual([
      "Deploying today",
    ]);
  });

  it("reports not admitted when the host never lets the bot in, and makes it leave", async () => {
    const bot = service();
    now = at(-90_000);
    await bot.tick();
    vexa.meeting = { ...vexa.meeting, status: "awaiting_admission" };
    now = at(-60_000);
    await bot.tick();

    now = at(-90_000 + ADMISSION_BACKSTOP_MS);
    await bot.tick();
    expect(vexa.botRunning).toBe(false);

    vexa.meeting = { ...vexa.meeting, status: "completed", data: { completion_reason: "stopped" } };
    now = at(-75_000 + ADMISSION_BACKSTOP_MS);
    await bot.tick();
    expect(await only()).toMatchObject({
      status: "not_admitted",
      reason: "admission_deadline",
      admittedAt: null,
    });
    expect(reported).toContainEqual({ operation: "standup_occurrence", status: "not_admitted" });
  });

  it("enforces the maximum length even when Vexa status reads fail", async () => {
    const bot = service();
    await admitted(bot);
    vexa.failStatusReads = true;
    now = at(MAX_ACTIVE_MS);
    await bot.tick();

    expect(vexa.stops).toBe(1);
    expect(await only()).toMatchObject({ status: "stopping", reason: "max_duration" });
    expect(reported.map((report) => report.operation)).toContain("standup_status_sync");
  });

  it("keeps asking the bot to leave until Vexa confirms it is gone", async () => {
    const bot = service();
    const occurrence = await admitted(bot);
    vexa.failStops = 1;
    now = at(60_000);
    await bot.stop(occurrence.id);
    expect(reported.map((report) => report.operation)).toContain("standup_bot_leave");

    now = at(75_000);
    await bot.tick();
    expect(vexa.stops).toBe(2);

    vexa.meeting = { ...vexa.meeting, status: "completed", data: { completion_reason: "stopped" } };
    now = at(90_000);
    await bot.tick();
    expect(await store.getOccurrence(occurrence.id)).toMatchObject({
      status: "stopped",
      reason: "operator",
    });
  });

  it("keeps making an untracked bot leave until Vexa confirms it is gone", async () => {
    const bot = service({
      setVexaMeetingId: async () => {
        throw new Error("database unavailable");
      },
    });
    vexa.failStops = 1;
    now = at(-90_000);
    await bot.tick();
    expect(await only()).toMatchObject({
      status: "failed",
      reason: "tracking_failed",
      leaveConfirmedAt: null,
    });

    now = at(-75_000);
    await bot.tick(); // DELETE reaches the running bot
    now = at(-60_000);
    await bot.tick(); // Vexa answers 404: the bot is gone
    expect(vexa.botRunning).toBe(false);
    expect((await only()).leaveConfirmedAt).not.toBeNull();
    const stops = vexa.stops;
    now = at(-45_000);
    await bot.tick();
    expect(vexa.stops).toBe(stops);
  });

  it("still makes the bot leave after an outage outlasts the leave confirmation window", async () => {
    const bot = service();
    const occurrence = await admitted(bot);
    vexa.failStops = 1_000;
    vexa.failStatusReads = true;
    now = at(60_000);
    await bot.stop(occurrence.id);
    now = at(60_000 + LEAVE_CONFIRMATION_MS);
    await bot.tick();
    expect(await store.getOccurrence(occurrence.id)).toMatchObject({
      status: "failed",
      reason: "leave_unconfirmed",
    });
    expect(vexa.botRunning).toBe(true);

    expect(reported.map((report) => report.operation)).toContain("standup_leave_status_read");

    vexa.failStops = 0;
    now = at(120_000 + LEAVE_CONFIRMATION_MS);
    await bot.tick();
    expect(vexa.botRunning).toBe(false);
  });

  it("makes the bot leave when an operator stop races its creation", async () => {
    const bot = service();
    const operator = service();
    vexa.duringRequest = async () => {
      const [occurrence] = await store.listOpenOccurrences();
      if (occurrence) await operator.stop(occurrence.id); // DELETE answers 404: no bot yet
    };
    now = at(-90_000);
    await bot.tick();

    expect(vexa.botRunning).toBe(false);
    expect(await only()).toMatchObject({ status: "stopping", reason: "operator" });
  });

  it("reports Vexa stream error frames", async () => {
    const bot = service();
    await admitted(bot);
    emit({ type: "error", error: "authorization_call_failed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reported.map((report) => report.operation)).toContain("standup_stream_error_frame");
  });

  it("retries final transcript reconciliation on later ticks", async () => {
    const bot = service();
    const occurrence = await admitted(bot);
    vexa.meeting = {
      ...vexa.meeting,
      status: "completed",
      data: { completion_reason: "left_alone" },
    };
    vexa.failSegmentReads = true;
    now = at(600_000);
    await bot.tick();
    expect(await store.getOccurrence(occurrence.id)).toMatchObject({
      status: "completed",
      transcriptReconciledAt: null,
    });

    vexa.failSegmentReads = false;
    vexa.segments = [segment("s9", "Blocked on review")];
    now = at(615_000);
    await bot.tick();
    expect((await store.listSegments(occurrence.id)).map((row) => row.text)).toEqual([
      "Blocked on review",
    ]);
    expect((await store.getOccurrence(occurrence.id))?.transcriptReconciledAt).not.toBeNull();
  });

  it("records a standup missed while the service was down, instead of joining late", async () => {
    const bot = service();
    now = at(2 * 60 * 60_000);
    await bot.tick();
    expect(vexa.botRequests).toBe(0);
    expect(await only()).toMatchObject({ status: "missed", scheduledStart: start });
  });
});
