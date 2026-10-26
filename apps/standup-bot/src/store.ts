/**
 * Postgres storage owned by the standup bot. Later phases read
 * `standup_transcript_segments` joined to `standup_occurrences` and
 * `standup_series`; nothing else writes these tables.
 */
import { Schema } from "effect";
import {
  advanceOccurrence,
  OCCURRENCE_STATUSES,
  type OccurrenceEvent,
  type OccurrenceState,
  type Transition,
} from "./occurrence-machine.ts";
import { parseStandupSchedule, Weekday, type StandupSchedule } from "./schedule.ts";
import type { VexaSegment } from "./vexa.ts";

/** The subset of `pg.Pool` and PGlite this store uses. */
export type SqlClient = {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS standup_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  meeting_url text NOT NULL,
  meet_code text NOT NULL,
  weekdays text[] NOT NULL,
  start_time text NOT NULL,
  time_zone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS standup_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  series_id uuid NOT NULL REFERENCES standup_series(id),
  scheduled_start timestamptz NOT NULL,
  status text NOT NULL,
  reason text,
  requested_at timestamptz,
  admitted_at timestamptz,
  stop_requested_at timestamptz,
  ended_at timestamptz,
  vexa_meeting_id integer,
  transcript_reconciled_at timestamptz,
  leave_requested_at timestamptz,
  leave_confirmed_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_id, scheduled_start)
);

CREATE INDEX IF NOT EXISTS standup_occurrences_status_idx ON standup_occurrences (status);

CREATE TABLE IF NOT EXISTS standup_transcript_segments (
  occurrence_id uuid NOT NULL REFERENCES standup_occurrences(id) ON DELETE CASCADE,
  vexa_segment_id text NOT NULL,
  speaker text,
  speaker_key text,
  text text NOT NULL,
  start_seconds double precision NOT NULL,
  end_seconds double precision NOT NULL,
  absolute_start_at timestamptz,
  absolute_end_at timestamptz,
  language text,
  source text,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (occurrence_id, vexa_segment_id)
);
`;

const NullableDate = Schema.NullOr(Schema.Date);

const SeriesRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  meeting_url: Schema.String,
  meet_code: Schema.String,
  weekdays: Schema.Array(Weekday),
  start_time: Schema.String,
  time_zone: Schema.String,
  enabled: Schema.Boolean,
  created_at: Schema.Date,
});

const OccurrenceRow = Schema.Struct({
  id: Schema.String,
  series_id: Schema.String,
  scheduled_start: Schema.Date,
  status: Schema.Literals(OCCURRENCE_STATUSES),
  reason: Schema.NullOr(Schema.String),
  requested_at: NullableDate,
  admitted_at: NullableDate,
  stop_requested_at: NullableDate,
  ended_at: NullableDate,
  vexa_meeting_id: Schema.NullOr(Schema.Int),
  transcript_reconciled_at: NullableDate,
  leave_requested_at: NullableDate,
  leave_confirmed_at: NullableDate,
  version: Schema.Int,
});

const SegmentRow = Schema.Struct({
  vexa_segment_id: Schema.String,
  speaker: Schema.NullOr(Schema.String),
  text: Schema.String,
  start_seconds: Schema.Number,
  end_seconds: Schema.Number,
  absolute_start_at: NullableDate,
});

export type StandupSeries = {
  id: string;
  name: string;
  meetingUrl: string;
  meetCode: string;
  schedule: StandupSchedule;
  enabled: boolean;
  createdAt: Date;
};

export type Occurrence = OccurrenceState & {
  id: string;
  seriesId: string;
  scheduledStart: Date;
  vexaMeetingId: number | null;
  transcriptReconciledAt: Date | null;
  leaveRequestedAt: Date | null;
  leaveConfirmedAt: Date | null;
  version: number;
};

export type StoredSegment = {
  segmentId: string;
  speaker: string | null;
  text: string;
  startSeconds: number;
  endSeconds: number;
  absoluteStartAt: Date | null;
};

export function createStore(sql: SqlClient) {
  async function rows<S extends Schema.Decoder<unknown>>(
    schema: S,
    text: string,
    params: unknown[] = [],
  ): Promise<S["Type"][]> {
    const decode = Schema.decodeUnknownSync(schema);
    const result = await sql.query(text, params);
    return result.rows.map((row) => decode(row));
  }

  async function getOccurrence(id: string): Promise<Occurrence | null> {
    const [row] = await rows(OccurrenceRow, "SELECT * FROM standup_occurrences WHERE id = $1", [
      id,
    ]);
    return row ? toOccurrence(row) : null;
  }

  return {
    async migrate() {
      for (const statement of SCHEMA.split(";")) {
        if (statement.trim()) await sql.query(statement);
      }
    },

    async addSeries(input: {
      name: string;
      meetingUrl: string;
      meetCode: string;
      schedule: StandupSchedule;
    }): Promise<StandupSeries> {
      const schedule = parseStandupSchedule(input.schedule);
      const [row] = await rows(
        SeriesRow,
        `INSERT INTO standup_series (name, meeting_url, meet_code, weekdays, start_time, time_zone)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          input.name,
          input.meetingUrl,
          input.meetCode,
          schedule.weekdays,
          schedule.startTime,
          schedule.timeZone,
        ],
      );
      if (!row) throw new Error("Series insert returned no row");
      return toSeries(row);
    },

    async setSeriesEnabled(id: string, enabled: boolean) {
      await sql.query("UPDATE standup_series SET enabled = $2 WHERE id = $1", [id, enabled]);
    },

    async listSeries(options: { enabledOnly?: boolean } = {}): Promise<StandupSeries[]> {
      const found = await rows(
        SeriesRow,
        `SELECT * FROM standup_series ${options.enabledOnly ? "WHERE enabled" : ""} ORDER BY created_at`,
      );
      return found.map(toSeries);
    },

    /** Creates the occurrence once; repeated scheduler ticks return the same row. */
    async ensureOccurrence(seriesId: string, scheduledStart: Date): Promise<Occurrence> {
      await sql.query(
        `INSERT INTO standup_occurrences (series_id, scheduled_start, status)
         VALUES ($1, $2, 'scheduled') ON CONFLICT (series_id, scheduled_start) DO NOTHING`,
        [seriesId, scheduledStart],
      );
      const [row] = await rows(
        OccurrenceRow,
        "SELECT * FROM standup_occurrences WHERE series_id = $1 AND scheduled_start = $2",
        [seriesId, scheduledStart],
      );
      if (!row) throw new Error("Occurrence upsert returned no row");
      return toOccurrence(row);
    },

    getOccurrence,

    async listOpenOccurrences(): Promise<Occurrence[]> {
      const found = await rows(
        OccurrenceRow,
        `SELECT * FROM standup_occurrences
         WHERE status NOT IN ('completed', 'stopped', 'not_admitted', 'failed', 'missed')
         ORDER BY scheduled_start`,
      );
      return found.map(toOccurrence);
    },

    /** Ended occurrences whose final transcript has not been fetched from Vexa yet. */
    async listUnreconciledOccurrences(endedSince: Date): Promise<Occurrence[]> {
      const found = await rows(
        OccurrenceRow,
        `SELECT * FROM standup_occurrences
         WHERE status IN ('completed', 'stopped', 'not_admitted', 'failed')
           AND vexa_meeting_id IS NOT NULL AND transcript_reconciled_at IS NULL
           AND ended_at >= $1
         ORDER BY ended_at`,
        [endedSince],
      );
      return found.map(toOccurrence);
    },

    /**
     * Records that this service asked the bot to leave. The request stays
     * pending, whatever the occurrence's outcome, until Vexa confirms the bot
     * is gone.
     */
    async requestLeave(id: string, at: Date) {
      await sql.query(
        `UPDATE standup_occurrences SET leave_requested_at = COALESCE(leave_requested_at, $2),
           leave_confirmed_at = NULL, updated_at = now() WHERE id = $1`,
        [id, at],
      );
    },

    async confirmLeave(id: string) {
      await sql.query(
        `UPDATE standup_occurrences SET leave_confirmed_at = now(), updated_at = now()
         WHERE id = $1 AND leave_requested_at IS NOT NULL AND leave_confirmed_at IS NULL`,
        [id],
      );
    },

    async listPendingLeaves(): Promise<Occurrence[]> {
      const found = await rows(
        OccurrenceRow,
        `SELECT * FROM standup_occurrences
         WHERE leave_requested_at IS NOT NULL AND leave_confirmed_at IS NULL
         ORDER BY leave_requested_at`,
      );
      return found.map(toOccurrence);
    },

    async markTranscriptReconciled(id: string) {
      await sql.query(
        "UPDATE standup_occurrences SET transcript_reconciled_at = now(), updated_at = now() WHERE id = $1",
        [id],
      );
    },

    async listRecentOccurrences(limit: number): Promise<Occurrence[]> {
      const found = await rows(
        OccurrenceRow,
        "SELECT * FROM standup_occurrences ORDER BY scheduled_start DESC LIMIT $1",
        [limit],
      );
      return found.map(toOccurrence);
    },

    /**
     * Applies one lifecycle event with optimistic concurrency, so the
     * scheduler and an operator's stop command can race safely. A transition
     * that asks the bot to leave records the pending leave in the same write.
     */
    async applyEvent(
      id: string,
      event: OccurrenceEvent,
    ): Promise<{ occurrence: Occurrence; transition: Transition; changed: boolean } | null> {
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await getOccurrence(id);
        if (!current) return null;
        const transition = advanceOccurrence(current, event);
        if (transition.state === current)
          return { occurrence: current, transition, changed: false };
        const next = transition.state;
        const updated = await rows(
          OccurrenceRow,
          `UPDATE standup_occurrences SET status = $3, reason = $4, requested_at = $5,
             admitted_at = $6, stop_requested_at = $7, ended_at = $8,
             leave_requested_at = CASE WHEN $9 THEN COALESCE(leave_requested_at, $10) ELSE leave_requested_at END,
             leave_confirmed_at = CASE WHEN $9 THEN NULL ELSE leave_confirmed_at END,
             version = version + 1, updated_at = now()
           WHERE id = $1 AND version = $2 RETURNING *`,
          [
            id,
            current.version,
            next.status,
            next.reason,
            next.requestedAt,
            next.admittedAt,
            next.stopRequestedAt,
            next.endedAt,
            transition.leaveMeeting,
            event.at,
          ],
        );
        const [row] = updated;
        if (row) return { occurrence: toOccurrence(row), transition, changed: true };
      }
      throw new Error(`Occurrence ${id} kept changing while applying ${event.type}`);
    },

    async setVexaMeetingId(id: string, vexaMeetingId: number) {
      await sql.query(
        "UPDATE standup_occurrences SET vexa_meeting_id = $2, updated_at = now() WHERE id = $1",
        [id, vexaMeetingId],
      );
    },

    /** Upserts confirmed segments. A later confirmation of the same segment id replaces the earlier text. */
    async saveSegments(
      occurrenceId: string,
      segments: ReadonlyArray<VexaSegment>,
    ): Promise<number> {
      let saved = 0;
      for (const segment of segments) {
        const text = segment.text?.trim();
        if (!segment.segment_id || !text) continue;
        await sql.query(
          `INSERT INTO standup_transcript_segments (occurrence_id, vexa_segment_id, speaker, speaker_key,
             text, start_seconds, end_seconds, absolute_start_at, absolute_end_at, language, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (occurrence_id, vexa_segment_id) DO UPDATE SET
             speaker = EXCLUDED.speaker, speaker_key = EXCLUDED.speaker_key, text = EXCLUDED.text,
             start_seconds = EXCLUDED.start_seconds, end_seconds = EXCLUDED.end_seconds,
             absolute_start_at = EXCLUDED.absolute_start_at, absolute_end_at = EXCLUDED.absolute_end_at,
             language = EXCLUDED.language, source = EXCLUDED.source, received_at = now()`,
          [
            occurrenceId,
            segment.segment_id,
            // Vexa publishes an empty speaker when it cannot attribute a turn.
            segment.speaker?.trim() || null,
            segment.speaker_key ?? null,
            text,
            Math.min(segment.start, segment.end),
            Math.max(segment.start, segment.end),
            segment.absolute_start_time ?? null,
            segment.absolute_end_time ?? null,
            segment.language ?? null,
            segment.source ?? null,
          ],
        );
        saved++;
      }
      return saved;
    },

    async deleteSegments(occurrenceId: string, segmentIds: ReadonlyArray<string>) {
      if (segmentIds.length === 0) return;
      await sql.query(
        "DELETE FROM standup_transcript_segments WHERE occurrence_id = $1 AND vexa_segment_id = ANY($2)",
        [occurrenceId, segmentIds],
      );
    },

    async listSegments(occurrenceId: string): Promise<StoredSegment[]> {
      const found = await rows(
        SegmentRow,
        `SELECT vexa_segment_id, speaker, text, start_seconds, end_seconds, absolute_start_at
         FROM standup_transcript_segments WHERE occurrence_id = $1
         ORDER BY start_seconds, vexa_segment_id`,
        [occurrenceId],
      );
      return found.map((row) => ({
        segmentId: row.vexa_segment_id,
        speaker: row.speaker,
        text: row.text,
        startSeconds: row.start_seconds,
        endSeconds: row.end_seconds,
        absoluteStartAt: row.absolute_start_at,
      }));
    },
  };
}

export type StandupStore = ReturnType<typeof createStore>;

function toSeries(row: typeof SeriesRow.Type): StandupSeries {
  return {
    id: row.id,
    name: row.name,
    meetingUrl: row.meeting_url,
    meetCode: row.meet_code,
    schedule: { weekdays: row.weekdays, startTime: row.start_time, timeZone: row.time_zone },
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

function toOccurrence(row: typeof OccurrenceRow.Type): Occurrence {
  return {
    id: row.id,
    seriesId: row.series_id,
    scheduledStart: row.scheduled_start,
    status: row.status,
    reason: row.reason,
    requestedAt: row.requested_at,
    admittedAt: row.admitted_at,
    stopRequestedAt: row.stop_requested_at,
    endedAt: row.ended_at,
    vexaMeetingId: row.vexa_meeting_id,
    transcriptReconciledAt: row.transcript_reconciled_at,
    leaveRequestedAt: row.leave_requested_at,
    leaveConfirmedAt: row.leave_confirmed_at,
    version: row.version,
  };
}
