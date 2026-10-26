import { TZDate } from "@date-fns/tz";
import { Schema } from "effect";

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const Weekday = Schema.Literals(WEEKDAYS);
export type Weekday = typeof Weekday.Type;

export const StandupSchedule = Schema.Struct({
  weekdays: Schema.Array(Weekday).check(Schema.isMinLength(1)),
  startTime: Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
  timeZone: Schema.String.check(
    Schema.makeFilter(isTimeZone, { message: "unknown IANA time zone" }),
  ),
});
export type StandupSchedule = typeof StandupSchedule.Type;

/** Validates a schedule; throws a SchemaError naming the invalid field. */
export const parseStandupSchedule = Schema.decodeUnknownSync(StandupSchedule);

/** The bot is requested this long before the standup starts, so it is in the lobby on time. */
export const JOIN_LEAD_MS = 90_000;
/** A standup that started longer ago than this is recorded as missed, never joined late. */
export const LATE_JOIN_GRACE_MS = 10 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Start instants of every occurrence whose start falls in [from, to). */
export function occurrencesBetween(schedule: StandupSchedule, from: Date, to: Date): Date[] {
  const [hours, minutes] = schedule.startTime.split(":").map(Number);
  const local = new TZDate(from.getTime(), schedule.timeZone);
  const days = Math.ceil((to.getTime() - from.getTime()) / DAY_MS) + 1;
  const starts: Date[] = [];
  for (let offset = -1; offset <= days; offset++) {
    const start = new TZDate(
      local.getFullYear(),
      local.getMonth(),
      local.getDate() + offset,
      hours ?? 0,
      minutes ?? 0,
      0,
      0,
      schedule.timeZone,
    );
    const weekday = WEEKDAYS[start.getDay()];
    if (!weekday || !schedule.weekdays.includes(weekday)) continue;
    if (start.getTime() >= from.getTime() && start.getTime() < to.getTime()) {
      starts.push(new Date(start.getTime()));
    }
  }
  return starts;
}

/** After downtime, occurrences up to this far back are still recorded (as missed). */
export const MISSED_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Occurrences the scheduler tracks: everything up to the join lead, reaching
 * back over a day of downtime but never before the series existed.
 */
export function occurrencesToTrack(schedule: StandupSchedule, now: Date, notBefore: Date): Date[] {
  return occurrencesBetween(
    schedule,
    new Date(Math.max(now.getTime() - MISSED_LOOKBACK_MS, notBefore.getTime())),
    new Date(now.getTime() + JOIN_LEAD_MS + 1),
  );
}

export type JoinDecision = "wait" | "request_bot" | "missed";

export function joinDecision(scheduledStart: Date, now: Date): JoinDecision {
  const start = scheduledStart.getTime();
  if (now.getTime() < start - JOIN_LEAD_MS) return "wait";
  if (now.getTime() > start + LATE_JOIN_GRACE_MS) return "missed";
  return "request_bot";
}

function isTimeZone(value: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone !== "";
  } catch {
    return false;
  }
}
