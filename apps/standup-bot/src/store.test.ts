import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createStore, type StandupStore } from "./store.ts";

let store: StandupStore;
let occurrenceId: string;

beforeEach(async () => {
  store = createStore(new PGlite());
  await store.migrate();
  await store.migrate();
  const series = await store.addSeries({
    name: "Engineering standup",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    meetCode: "abc-defg-hij",
    schedule: { weekdays: ["mon"], startTime: "09:30", timeZone: "America/Los_Angeles" },
  });
  occurrenceId = (await store.ensureOccurrence(series.id, new Date("2026-10-19T16:30:00Z"))).id;
});

describe("occurrences", () => {
  it("creates one occurrence per series and start, however often the scheduler asks", async () => {
    const [series] = await store.listSeries();
    const again = await store.ensureOccurrence(series!.id, new Date("2026-10-19T16:30:00Z"));
    expect(again.id).toBe(occurrenceId);
    expect(await store.listOpenOccurrences()).toHaveLength(1);
  });

  it("lets exactly one of two racing writers claim the bot request", async () => {
    const at = new Date("2026-10-19T16:29:00Z");
    const results = await Promise.all([
      store.applyEvent(occurrenceId, { type: "bot_request_started", at }),
      store.applyEvent(occurrenceId, { type: "bot_request_started", at }),
    ]);
    expect(results.filter((result) => result?.changed)).toHaveLength(1);
    expect((await store.getOccurrence(occurrenceId))?.status).toBe("requested");
  });

  it("records a pending leave in the same write as the transition that asks the bot to leave", async () => {
    const at = new Date("2026-10-19T16:29:00Z");
    await store.applyEvent(occurrenceId, { type: "bot_request_started", at });
    await store.applyEvent(occurrenceId, { type: "stop_requested", at, by: "operator" });
    expect(await store.listPendingLeaves()).toMatchObject([
      { id: occurrenceId, leaveRequestedAt: at },
    ]);
    await store.confirmLeave(occurrenceId);
    expect(await store.listPendingLeaves()).toEqual([]);
  });
});

describe("transcript segments", () => {
  const segment = {
    segment_id: "sess:ch-0:1:1500",
    speaker: "Alice",
    speaker_key: "ch-0:1",
    text: "hello wor",
    start: 1.5,
    end: 2.5,
    completed: true,
    absolute_start_time: "2026-10-19T16:30:01.500Z",
  };

  it("replaces a segment's text when Vexa re-confirms the same segment id", async () => {
    await store.saveSegments(occurrenceId, [segment]);
    await store.saveSegments(occurrenceId, [{ ...segment, text: "hello world" }]);
    expect(await store.listSegments(occurrenceId)).toEqual([
      {
        segmentId: segment.segment_id,
        speaker: "Alice",
        text: "hello world",
        startSeconds: 1.5,
        endSeconds: 2.5,
        absoluteStartAt: new Date(segment.absolute_start_time),
      },
    ]);
  });

  it("stores unattributed turns with no speaker and skips segments it cannot key", async () => {
    const saved = await store.saveSegments(occurrenceId, [
      { ...segment, segment_id: "b", speaker: "", start: 4, end: 5, text: "who said this" },
      { ...segment, segment_id: undefined, text: "no id" },
      { ...segment, segment_id: "c", text: "   " },
    ]);
    expect(saved).toBe(1);
    expect(await store.listSegments(occurrenceId)).toMatchObject([
      { segmentId: "b", speaker: null },
    ]);
  });

  it("orders by start time and removes retracted segments", async () => {
    await store.saveSegments(occurrenceId, [
      { ...segment, segment_id: "late", start: 9, end: 10 },
      { ...segment, segment_id: "early", start: 1, end: 2 },
      { ...segment, segment_id: "gone", start: 5, end: 6 },
    ]);
    await store.deleteSegments(occurrenceId, ["gone"]);
    expect((await store.listSegments(occurrenceId)).map((row) => row.segmentId)).toEqual([
      "early",
      "late",
    ]);
  });
});
