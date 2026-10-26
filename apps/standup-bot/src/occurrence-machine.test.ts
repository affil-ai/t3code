import { describe, expect, it } from "vite-plus/test";
import {
  ADMISSION_BACKSTOP_MS,
  advanceOccurrence,
  initialOccurrenceState,
  LEAVE_CONFIRMATION_MS,
  MAX_ACTIVE_MS,
  type OccurrenceEvent,
  type OccurrenceState,
  type Transition,
} from "./occurrence-machine.ts";

const t0 = new Date("2026-10-20T16:28:30Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

function run(events: OccurrenceEvent[], from = initialOccurrenceState()) {
  let state: OccurrenceState = from;
  const transitions: Transition[] = [];
  for (const event of events) {
    const transition = advanceOccurrence(state, event);
    transitions.push(transition);
    state = transition.state;
  }
  return { state, leaves: transitions.filter((transition) => transition.leaveMeeting).length };
}

const requested: OccurrenceEvent = { type: "bot_request_started", at: t0 };
const inLobby: OccurrenceEvent = {
  type: "vexa_status",
  at: at(5_000),
  status: "awaiting_admission",
};
const admitted: OccurrenceEvent = { type: "vexa_status", at: at(60_000), status: "active" };
const ended = (
  ms: number,
  status: "completed" | "failed",
  completionReason: string | null,
  failureStage: string | null = null,
): OccurrenceEvent => ({ type: "vexa_ended", at: at(ms), status, completionReason, failureStage });

describe("admission", () => {
  it("records the admission time and completes when the bot leaves on its own", () => {
    const { state } = run([
      requested,
      inLobby,
      admitted,
      ended(900_000, "completed", "left_alone"),
    ]);
    expect(state).toMatchObject({
      status: "completed",
      reason: "left_alone",
      admittedAt: at(60_000),
    });
  });

  it.each(["awaiting_admission_timeout", "awaiting_admission_rejected"])(
    "reports not_admitted when Vexa ends with %s",
    (reason) => {
      const { state } = run([requested, inLobby, ended(600_000, "completed", reason)]);
      expect(state).toMatchObject({ status: "not_admitted", reason, admittedAt: null });
    },
  );

  it("treats a lobby failure as not admitted, and a later failure as failed", () => {
    expect(
      run([requested, inLobby, ended(600_000, "failed", null, "awaiting_admission")]).state.status,
    ).toBe("not_admitted");
    expect(
      run([requested, inLobby, admitted, ended(600_000, "failed", null, "active")]).state,
    ).toMatchObject({
      status: "failed",
      reason: "active",
    });
  });

  it("keeps waiting in the lobby when Vexa reports needs_help", () => {
    const { state, leaves } = run([
      requested,
      inLobby,
      { type: "vexa_status", at: at(30_000), status: "needs_help" },
    ]);
    expect(state.status).toBe("awaiting_admission");
    expect(leaves).toBe(0);
  });

  it("asks the bot to leave at the backstop deadline and reports not_admitted", () => {
    const { state, leaves } = run([
      requested,
      inLobby,
      { type: "deadline_check", at: at(ADMISSION_BACKSTOP_MS - 1) },
      { type: "deadline_check", at: at(ADMISSION_BACKSTOP_MS) },
      ended(ADMISSION_BACKSTOP_MS + 5_000, "completed", "stopped"),
    ]);
    expect(leaves).toBe(1);
    expect(state).toMatchObject({ status: "not_admitted", reason: "admission_deadline" });
  });

  it("still reports not_admitted when Vexa never confirms the leave", () => {
    const { state } = run([
      requested,
      inLobby,
      { type: "deadline_check", at: at(ADMISSION_BACKSTOP_MS) },
      { type: "deadline_check", at: at(ADMISSION_BACKSTOP_MS + LEAVE_CONFIRMATION_MS) },
    ]);
    expect(state).toMatchObject({ status: "not_admitted", reason: "admission_deadline" });
  });
});

describe("stop", () => {
  it("makes an admitted bot leave and records an operator stop", () => {
    const { state, leaves } = run([
      requested,
      inLobby,
      admitted,
      { type: "stop_requested", at: at(120_000), by: "operator" },
      { type: "stop_requested", at: at(121_000), by: "operator" },
      ended(125_000, "completed", "stopped"),
    ]);
    expect(leaves).toBe(1);
    expect(state).toMatchObject({ status: "stopped", reason: "operator" });
  });

  it("cancels an occurrence before any bot is requested", () => {
    const { state, leaves } = run([{ type: "stop_requested", at: t0, by: "operator" }]);
    expect(leaves).toBe(0);
    expect(state.status).toBe("stopped");
    expect(run([requested], state).state.status).toBe("stopped");
  });

  it("stops a bot that stays past the maximum standup length", () => {
    const { state, leaves } = run([
      requested,
      admitted,
      { type: "deadline_check", at: at(60_000 + MAX_ACTIVE_MS) },
      ended(60_000 + MAX_ACTIVE_MS + 5_000, "completed", "stopped"),
    ]);
    expect(leaves).toBe(1);
    expect(state).toMatchObject({ status: "stopped", reason: "max_duration" });
  });

  it("ignores Vexa frames after a terminal outcome", () => {
    const done = run([
      requested,
      inLobby,
      ended(600_000, "completed", "awaiting_admission_timeout"),
    ]).state;
    expect(
      run([admitted, { type: "stop_requested", at: at(700_000), by: "operator" }], done),
    ).toEqual({
      state: done,
      leaves: 0,
    });
  });
});
