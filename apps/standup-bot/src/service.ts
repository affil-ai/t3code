import type { OccurrenceEvent } from "./occurrence-machine.ts";
import { isTerminal } from "./occurrence-machine.ts";
import { joinDecision, MISSED_LOOKBACK_MS, occurrencesToTrack } from "./schedule.ts";
import type { Occurrence, StandupSeries, StandupStore } from "./store.ts";
import {
  isLiveStatus,
  meetingStatus,
  VexaRequestError,
  type VexaClient,
  type VexaFrame,
  type VexaMeetingStatus,
} from "./vexa.ts";

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/**
 * Reports a failure the service absorbs and continues past. Properties carry
 * ids and reasons only, never transcript text or speaker names.
 */
export type ReportFailure = (failure: {
  operation: string;
  error: unknown;
  kind: "returned_failure" | "thrown_error";
  properties?: Record<string, string | number | boolean | null>;
}) => void;

/** A live `/ws` subscription for one Vexa meeting. */
export type MeetingStream = { close(): void };
export type OpenMeetingStream = (input: {
  occurrenceId: string;
  meetCode: string;
  onFrame: (frame: VexaFrame) => void;
  /** Called after every (re)connect so missed segments can be backfilled. */
  onConnected: () => void;
}) => MeetingStream;

export type StandupService = ReturnType<typeof createStandupService>;

/** Terminal outcomes in which the standup was not transcribed as planned. */
const FAILED_OUTCOMES = new Set(["not_admitted", "failed", "missed"]);

export function createStandupService(deps: {
  store: StandupStore;
  vexa: VexaClient;
  openStream: OpenMeetingStream;
  reportFailure: ReportFailure;
  now?: () => Date;
  log?: Log;
}) {
  const { store, vexa, reportFailure } = deps;
  const now = deps.now ?? (() => new Date());
  const log: Log = deps.log ?? (() => {});
  const streams = new Map<string, MeetingStream>();

  function fail(operation: string, error: unknown, occurrenceId: string) {
    log(`${operation}_failed`, { occurrenceId, error: String(error) });
    reportFailure({
      operation,
      error,
      kind: "thrown_error",
      properties: { occurrence_id: occurrenceId },
    });
  }

  /**
   * Sends one DELETE for a leave already recorded as pending (by the
   * transition or `requestLeave`); the sweep retries it until Vexa confirms.
   */
  async function leave(occurrence: Occurrence, meetCode: string) {
    try {
      const result = await vexa.stopBot(meetCode);
      log("bot_leave_requested", {
        occurrenceId: occurrence.id,
        reason: occurrence.reason,
        result,
      });
      if (result === "absent") await store.confirmLeave(occurrence.id);
    } catch (error) {
      fail("standup_bot_leave", error, occurrence.id);
    }
  }

  /**
   * Retries every unconfirmed leave, including on occurrences that already
   * reached a terminal outcome. It never touches a Meet code whose newer
   * occurrence has its own bot, because DELETE is addressed by Meet code.
   */
  async function confirmPendingLeaves(tickStartedAt: Date) {
    const open = await store.listOpenOccurrences();
    for (const occurrence of await store.listPendingLeaves()) {
      // A leave first requested during this tick was just sent.
      if (occurrence.leaveRequestedAt && occurrence.leaveRequestedAt >= tickStartedAt) continue;
      try {
        if (
          occurrence.vexaMeetingId !== null &&
          (await vexaRunEnded(occurrence.id, occurrence.vexaMeetingId))
        ) {
          await store.confirmLeave(occurrence.id);
          continue;
        }
        const newerBot = open.some(
          (other) =>
            other.id !== occurrence.id &&
            other.seriesId === occurrence.seriesId &&
            other.status !== "scheduled" &&
            other.scheduledStart > occurrence.scheduledStart,
        );
        if (newerBot) continue;
        const result = await vexa.stopBot(await meetCodeFor(occurrence));
        if (result === "absent") await store.confirmLeave(occurrence.id);
      } catch (error) {
        fail("standup_bot_leave", error, occurrence.id);
      }
    }
  }

  async function apply(occurrence: Occurrence, meetCode: string, event: OccurrenceEvent) {
    const result = await store.applyEvent(occurrence.id, event);
    if (!result) return null;
    const { occurrence: next, transition } = result;
    if (next.status !== occurrence.status) {
      log("occurrence_status", { occurrenceId: next.id, status: next.status, reason: next.reason });
      if (FAILED_OUTCOMES.has(next.status)) {
        reportFailure({
          operation: "standup_occurrence",
          error: new Error(`Standup occurrence ended ${next.status}: ${next.reason ?? "unknown"}`),
          kind: "returned_failure",
          properties: { occurrence_id: next.id, status: next.status, reason: next.reason },
        });
      }
    }
    if (transition.leaveMeeting) await leave(next, meetCode);
    // Vexa reporting the run ended is the confirmation that the bot has gone.
    if (event.type === "vexa_ended") await store.confirmLeave(next.id);
    if (isTerminal(next.status)) {
      streams.get(next.id)?.close();
      streams.delete(next.id);
      await reconcile(next);
    }
    return next;
  }

  /** Final transcript fetch. Retried on later ticks until it succeeds. */
  async function reconcile(occurrence: Occurrence) {
    if (occurrence.vexaMeetingId === null || occurrence.transcriptReconciledAt) return;
    try {
      const saved = await store.saveSegments(
        occurrence.id,
        await vexa.getConfirmedSegments(occurrence.vexaMeetingId),
      );
      await store.markTranscriptReconciled(occurrence.id);
      log("transcript_reconciled", { occurrenceId: occurrence.id, segments: saved });
    } catch (error) {
      fail("standup_transcript_reconcile", error, occurrence.id);
    }
  }

  async function applyVexaStatus(
    occurrence: Occurrence,
    meetCode: string,
    status: VexaMeetingStatus,
  ) {
    const at = now();
    if (isLiveStatus(status)) {
      return apply(occurrence, meetCode, { type: "vexa_status", at, status });
    }
    if (occurrence.vexaMeetingId === null) return occurrence;
    const meeting = await vexa.getMeeting(occurrence.vexaMeetingId);
    return apply(occurrence, meetCode, {
      type: "vexa_ended",
      at,
      status,
      completionReason: meeting.data?.completion_reason ?? null,
      failureStage: meeting.data?.failure_stage ?? null,
    });
  }

  async function requestBot(occurrence: Occurrence, series: StandupSeries) {
    const claimed = await store.applyEvent(occurrence.id, {
      type: "bot_request_started",
      at: now(),
    });
    // Only the process whose write moved the occurrence to `requested` sends the bot.
    if (!claimed?.changed || claimed.occurrence.status !== "requested") return;
    log("bot_requested", { occurrenceId: occurrence.id, seriesId: series.id });

    let meeting;
    try {
      meeting = await vexa.requestBot(series.meetCode);
    } catch (error) {
      const reason =
        error instanceof VexaRequestError ? `vexa_${error.status}` : "vexa_unreachable";
      fail("standup_bot_request", error, occurrence.id);
      await apply(claimed.occurrence, series.meetCode, {
        type: "bot_request_failed",
        at: now(),
        reason,
      });
      return;
    }

    try {
      await store.setVexaMeetingId(occurrence.id, meeting.id);
    } catch (error) {
      // A bot this service cannot track must not stay in the meeting. The
      // transition records the pending leave; if the store is down entirely,
      // the occurrence stays `requested` and the admission backstop retries.
      fail("standup_bot_tracking", error, occurrence.id);
      await apply(claimed.occurrence, series.meetCode, { type: "bot_untracked", at: now() });
      return;
    }

    const current = await store.getOccurrence(occurrence.id);
    if (!current) return;
    if (current.stopRequestedAt !== null || isTerminal(current.status)) {
      // A stop raced this creation: a DELETE sent before the bot existed may
      // have answered 404. Reopen the leave so it is retried against this bot.
      await store.requestLeave(current.id, now());
      await leave(current, series.meetCode);
      return;
    }
    const status = meetingStatus(meeting.status);
    if (status) await applyVexaStatus(current, series.meetCode, status);
  }

  function ensureStream(occurrence: Occurrence, meetCode: string) {
    const meetingId = occurrence.vexaMeetingId;
    if (meetingId === null || streams.has(occurrence.id)) return;
    const occurrenceId = occurrence.id;
    const handle = (task: () => Promise<unknown>) => {
      task().catch((error) => fail("standup_stream_frame", error, occurrenceId));
    };
    streams.set(
      occurrenceId,
      deps.openStream({
        occurrenceId,
        meetCode,
        onConnected: () =>
          handle(async () => {
            const segments = await vexa.getConfirmedSegments(meetingId);
            await store.saveSegments(occurrenceId, segments);
          }),
        onFrame: (frame) => {
          // One Meet link is reused by every occurrence; only this bot's Vexa meeting counts.
          if ("meetingId" in frame && frame.meetingId !== meetingId) return;
          if (frame.type === "transcript") {
            handle(() => store.saveSegments(occurrenceId, frame.confirmed));
          } else if (frame.type === "transcript_retract") {
            handle(() => store.deleteSegments(occurrenceId, frame.segmentIds));
          } else if (frame.type === "status") {
            handle(async () => {
              const current = await store.getOccurrence(occurrenceId);
              if (current && !isTerminal(current.status)) {
                await applyVexaStatus(current, meetCode, frame.status);
              }
            });
          } else if (frame.type === "error") {
            fail(
              "standup_stream_error_frame",
              new Error(`Vexa /ws error frame: ${frame.error}`),
              occurrenceId,
            );
          }
        },
      }),
    );
  }

  async function syncFromVexa(occurrence: Occurrence, meetCode: string) {
    if (occurrence.vexaMeetingId === null) return;
    try {
      const meeting = await vexa.getMeeting(occurrence.vexaMeetingId);
      const status = meetingStatus(meeting.status);
      if (status) await applyVexaStatus(occurrence, meetCode, status);
    } catch (error) {
      // Deadlines below still run when Vexa cannot be read.
      fail("standup_status_sync", error, occurrence.id);
    }
  }

  async function tickOccurrence(
    occurrence: Occurrence,
    series: StandupSeries | undefined,
    at: Date,
  ) {
    if (occurrence.status === "scheduled") {
      const decision = joinDecision(occurrence.scheduledStart, at);
      if (decision === "missed" || (decision === "request_bot" && !series)) {
        await apply(occurrence, series?.meetCode ?? "", { type: "join_window_missed", at });
      } else if (decision === "request_bot" && series) {
        await requestBot(occurrence, series);
      }
      return;
    }
    const meetCode = series?.meetCode ?? (await meetCodeFor(occurrence));
    await syncFromVexa(occurrence, meetCode);

    const latest = await store.getOccurrence(occurrence.id);
    if (!latest || isTerminal(latest.status)) return;
    const next = await apply(latest, meetCode, { type: "deadline_check", at });
    if (!next || isTerminal(next.status)) return;

    ensureStream(next, meetCode);
    // The stream is the fast path; this pass keeps the store current if frames were missed.
    if (next.status === "active" && next.vexaMeetingId !== null) {
      await store.saveSegments(next.id, await vexa.getConfirmedSegments(next.vexaMeetingId));
    }
  }

  /** Whether Vexa reports the bot's run as ended; `false`, reported, when Vexa cannot be read. */
  async function vexaRunEnded(occurrenceId: string, vexaMeetingId: number) {
    try {
      const status = meetingStatus((await vexa.getMeeting(vexaMeetingId)).status);
      return status === "completed" || status === "failed";
    } catch (error) {
      fail("standup_leave_status_read", error, occurrenceId);
      return false;
    }
  }

  async function meetCodeFor(occurrence: Occurrence) {
    const match = (await store.listSeries()).find((item) => item.id === occurrence.seriesId);
    if (!match) throw new Error(`Series ${occurrence.seriesId} not found`);
    return match.meetCode;
  }

  return {
    /** One scheduler pass. Safe to run repeatedly; every step is idempotent. */
    async tick() {
      const at = now();
      const series = await store.listSeries({ enabledOnly: true });
      const seriesById = new Map(series.map((item) => [item.id, item]));
      for (const item of series) {
        for (const start of occurrencesToTrack(item.schedule, at, item.createdAt)) {
          await store.ensureOccurrence(item.id, start);
        }
      }

      for (const occurrence of await store.listOpenOccurrences()) {
        try {
          await tickOccurrence(occurrence, seriesById.get(occurrence.seriesId), at);
        } catch (error) {
          fail("standup_occurrence_tick", error, occurrence.id);
        }
      }

      try {
        await confirmPendingLeaves(at);
      } catch (error) {
        log("standup_leave_sweep_failed", { error: String(error) });
        reportFailure({ operation: "standup_leave_sweep", error, kind: "thrown_error" });
      }

      const endedSince = new Date(at.getTime() - MISSED_LOOKBACK_MS);
      for (const occurrence of await store.listUnreconciledOccurrences(endedSince)) {
        await reconcile(occurrence);
      }
    },

    /** Operator stop: the bot leaves and transcription stops for this occurrence. */
    async stop(occurrenceId: string) {
      const occurrence = await store.getOccurrence(occurrenceId);
      if (!occurrence) throw new Error(`Unknown occurrence ${occurrenceId}`);
      return apply(occurrence, await meetCodeFor(occurrence), {
        type: "stop_requested",
        at: now(),
        by: "operator",
      });
    },

    close() {
      for (const stream of streams.values()) stream.close();
      streams.clear();
    },
  };
}
