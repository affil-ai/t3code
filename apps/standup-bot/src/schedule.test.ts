import { describe, expect, it } from "vite-plus/test";
import {
  JOIN_LEAD_MS,
  joinDecision,
  LATE_JOIN_GRACE_MS,
  occurrencesBetween,
  occurrencesToTrack,
  parseStandupSchedule,
} from "./schedule.ts";

const weekdayStandup = parseStandupSchedule({
  weekdays: ["mon", "tue", "wed", "thu", "fri"],
  startTime: "09:30",
  timeZone: "America/Los_Angeles",
});

describe("occurrencesBetween", () => {
  it("returns local start times on scheduled weekdays only", () => {
    // Fri 2026-10-16 through Tue 2026-10-20 (PDT, UTC-7).
    const starts = occurrencesBetween(
      weekdayStandup,
      new Date("2026-10-16T00:00:00Z"),
      new Date("2026-10-21T00:00:00Z"),
    );
    expect(starts.map((start) => start.toISOString())).toEqual([
      "2026-10-16T16:30:00.000Z",
      "2026-10-19T16:30:00.000Z",
      "2026-10-20T16:30:00.000Z",
    ]);
  });

  it("keeps the local start time across a daylight saving change", () => {
    // US DST ends Sun 2026-11-01; 09:30 PDT is 16:30Z, 09:30 PST is 17:30Z.
    const starts = occurrencesBetween(
      weekdayStandup,
      new Date("2026-10-30T00:00:00Z"),
      new Date("2026-11-03T00:00:00Z"),
    );
    expect(starts.map((start) => start.toISOString())).toEqual([
      "2026-10-30T16:30:00.000Z",
      "2026-11-02T17:30:00.000Z",
    ]);
  });

  it("rejects an unknown time zone", () => {
    expect(() => parseStandupSchedule({ ...weekdayStandup, timeZone: "Mars/Olympus" })).toThrow(
      /unknown IANA time zone/,
    );
  });
});

describe("join timing", () => {
  const start = new Date("2026-10-20T16:30:00Z");
  const at = (offsetMs: number) => new Date(start.getTime() + offsetMs);

  it("requests the bot inside the lead window and never after the late-join grace", () => {
    expect(joinDecision(start, at(-JOIN_LEAD_MS - 1))).toBe("wait");
    expect(joinDecision(start, at(-JOIN_LEAD_MS))).toBe("request_bot");
    expect(joinDecision(start, at(LATE_JOIN_GRACE_MS))).toBe("request_bot");
    expect(joinDecision(start, at(LATE_JOIN_GRACE_MS + 1))).toBe("missed");
  });

  it("tracks a day of past occurrences for missed reporting, but none before the series existed", () => {
    const created = new Date("2026-10-01T00:00:00Z");
    const yesterday = new Date("2026-10-19T16:30:00Z");
    expect(occurrencesToTrack(weekdayStandup, at(-JOIN_LEAD_MS - 60_000), created)).toEqual([
      yesterday,
    ]);
    expect(occurrencesToTrack(weekdayStandup, at(-JOIN_LEAD_MS), created)).toEqual([
      yesterday,
      start,
    ]);
    expect(occurrencesToTrack(weekdayStandup, at(-JOIN_LEAD_MS), at(-60 * 60_000))).toEqual([
      start,
    ]);
  });
});
