/**
 * Lifecycle of one standup occurrence, from schedule to a terminal outcome.
 *
 * Vexa owns the bot. This machine records what Vexa reports and decides when
 * this service must ask the bot to leave. Google Meet host admission is never
 * bypassed: the bot waits in the lobby until a host admits it, and an
 * occurrence that is not admitted before its deadline ends as `not_admitted`.
 */

export const OCCURRENCE_STATUSES = [
  "scheduled",
  "requested",
  "joining",
  "awaiting_admission",
  "active",
  "stopping",
  "completed",
  "stopped",
  "not_admitted",
  "failed",
  "missed",
] as const;
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

const TERMINAL: ReadonlySet<OccurrenceStatus> = new Set([
  "completed",
  "stopped",
  "not_admitted",
  "failed",
  "missed",
]);

/** Vexa sends the bot this long to wait in the Google Meet lobby before it gives up. */
export const ADMISSION_TIMEOUT_MS = 10 * 60_000;
/** If Vexa has not reported a verdict by then, this service asks the bot to leave. */
export const ADMISSION_BACKSTOP_MS = ADMISSION_TIMEOUT_MS + 2 * 60_000;
/** An admitted bot is asked to leave after this long even if the call continues. */
export const MAX_ACTIVE_MS = 60 * 60_000;
/** A leave Vexa has not confirmed by then is recorded without waiting further. */
export const LEAVE_CONFIRMATION_MS = 5 * 60_000;

export function isTerminal(status: OccurrenceStatus) {
  return TERMINAL.has(status);
}

export type OccurrenceState = {
  status: OccurrenceStatus;
  /** Why the occurrence reached its current terminal or stopping status. */
  reason: string | null;
  stopRequestedAt: Date | null;
  requestedAt: Date | null;
  admittedAt: Date | null;
  endedAt: Date | null;
};

/** Vexa lifecycle.v1 bot statuses that are not terminal. */
export type VexaLiveStatus =
  | "requested"
  | "joining"
  | "awaiting_admission"
  | "needs_help"
  | "active"
  | "stopping";

export type OccurrenceEvent =
  | { type: "bot_request_started"; at: Date }
  | { type: "bot_request_failed"; at: Date; reason: string }
  /** Vexa created a bot this service could not record; it must leave. */
  | { type: "bot_untracked"; at: Date }
  | { type: "vexa_status"; at: Date; status: VexaLiveStatus }
  | {
      type: "vexa_ended";
      at: Date;
      status: "completed" | "failed";
      completionReason: string | null;
      failureStage: string | null;
    }
  | { type: "stop_requested"; at: Date; by: "operator" | "max_duration" }
  | { type: "deadline_check"; at: Date }
  | { type: "join_window_missed"; at: Date };

export type Transition = {
  state: OccurrenceState;
  /** Ask Vexa to remove the bot from the meeting. */
  leaveMeeting: boolean;
};

const NOT_ADMITTED_REASONS = new Set(["awaiting_admission_timeout", "awaiting_admission_rejected"]);

const PRE_ADMISSION: ReadonlySet<OccurrenceStatus> = new Set([
  "requested",
  "joining",
  "awaiting_admission",
]);

export function initialOccurrenceState(): OccurrenceState {
  return {
    status: "scheduled",
    reason: null,
    stopRequestedAt: null,
    requestedAt: null,
    admittedAt: null,
    endedAt: null,
  };
}

export function advanceOccurrence(state: OccurrenceState, event: OccurrenceEvent): Transition {
  const stay = { state, leaveMeeting: false };
  if (isTerminal(state.status)) return stay;

  switch (event.type) {
    case "bot_request_started":
      if (state.status !== "scheduled") return stay;
      return move(state, { status: "requested", requestedAt: event.at });

    case "bot_request_failed":
      if (state.status !== "requested") return stay;
      return end(state, "failed", event.reason, event.at);

    case "bot_untracked":
      if (state.status !== "requested") return stay;
      return { ...end(state, "failed", "tracking_failed", event.at), leaveMeeting: true };

    case "join_window_missed":
      if (state.status !== "scheduled") return stay;
      return end(state, "missed", "join_window_passed", event.at);

    case "vexa_status":
      return applyLiveStatus(state, event.status, event.at);

    case "vexa_ended":
      return end(state, ...terminalOutcome(state, event), event.at);

    case "stop_requested":
      if (state.status === "scheduled") {
        return end(state, "stopped", event.by, event.at);
      }
      if (state.status === "stopping") return stay;
      return {
        state: { ...state, status: "stopping", reason: event.by, stopRequestedAt: event.at },
        leaveMeeting: true,
      };

    case "deadline_check":
      return checkDeadlines(state, event.at);
  }
}

function applyLiveStatus(state: OccurrenceState, status: VexaLiveStatus, at: Date): Transition {
  const stay = { state, leaveMeeting: false };
  if (state.status === "scheduled" || state.status === "stopping") return stay;
  switch (status) {
    case "requested":
      return stay;
    case "joining":
      return state.status === "requested" ? move(state, { status: "joining" }) : stay;
    // Vexa reports `needs_help` when the bot is stuck before admission. It is
    // still waiting for a host; nothing here tries to get past the lobby.
    case "awaiting_admission":
    case "needs_help":
      return PRE_ADMISSION.has(state.status) ? move(state, { status: "awaiting_admission" }) : stay;
    case "active":
      return state.status === "active"
        ? stay
        : move(state, { status: "active", admittedAt: state.admittedAt ?? at });
    case "stopping":
      return move(state, { status: "stopping" });
  }
}

function terminalOutcome(
  state: OccurrenceState,
  event: Extract<OccurrenceEvent, { type: "vexa_ended" }>,
): [OccurrenceStatus, string | null] {
  if (event.completionReason && NOT_ADMITTED_REASONS.has(event.completionReason)) {
    return ["not_admitted", event.completionReason];
  }
  if (state.admittedAt === null && state.reason === "admission_deadline") {
    return ["not_admitted", "admission_deadline"];
  }
  if (event.status === "failed") {
    return state.admittedAt === null && event.failureStage === "awaiting_admission"
      ? ["not_admitted", "awaiting_admission_failed"]
      : ["failed", event.failureStage ?? event.completionReason];
  }
  if (state.stopRequestedAt) return ["stopped", state.reason];
  return ["completed", event.completionReason];
}

function checkDeadlines(state: OccurrenceState, at: Date): Transition {
  const stay = { state, leaveMeeting: false };
  const now = at.getTime();
  if (
    PRE_ADMISSION.has(state.status) &&
    state.requestedAt &&
    now >= state.requestedAt.getTime() + ADMISSION_BACKSTOP_MS
  ) {
    return {
      state: {
        ...state,
        status: "stopping",
        reason: "admission_deadline",
        stopRequestedAt: at,
      },
      leaveMeeting: true,
    };
  }
  if (
    state.status === "stopping" &&
    state.stopRequestedAt &&
    now >= state.stopRequestedAt.getTime() + LEAVE_CONFIRMATION_MS
  ) {
    return state.admittedAt === null && state.reason === "admission_deadline"
      ? end(state, "not_admitted", "admission_deadline", at)
      : end(state, "failed", "leave_unconfirmed", at);
  }
  if (
    state.status === "active" &&
    state.admittedAt &&
    now >= state.admittedAt.getTime() + MAX_ACTIVE_MS
  ) {
    return advanceOccurrence(state, { type: "stop_requested", at, by: "max_duration" });
  }
  return stay;
}

function move(state: OccurrenceState, patch: Partial<OccurrenceState>): Transition {
  return { state: { ...state, ...patch }, leaveMeeting: false };
}

function end(
  state: OccurrenceState,
  status: OccurrenceStatus,
  reason: string | null,
  at: Date,
): Transition {
  return { state: { ...state, status, reason, endedAt: at }, leaveMeeting: false };
}
