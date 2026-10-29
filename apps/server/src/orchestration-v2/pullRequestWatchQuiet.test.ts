// fork: pr-watch-quiet
import type {
  PullRequestCheck,
  PullRequestComment,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { evaluatePullRequestWatch } from "./pullRequestWatch.ts";
import {
  PULL_REQUEST_WATCH_QUIET_MS,
  isPullRequestWatchQuiet,
  pullRequestWatchQuietMessage,
} from "./pullRequestWatchQuiet.ts";

const STARTED = "2026-10-02T12:00:00.000Z";
const at = (minutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse(STARTED) + minutes * 60_000));

const atMs = (minutes: number) => Date.parse(at(minutes));

const watch = (overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch => ({
  startedAt: STARTED,
  headSha: "aaaaaaaaaa",
  failedChecks: [],
  passed: false,
  passedChecks: [],
  remarksThrough: STARTED,
  remarkIds: [],
  conflicting: false,
  wakes: 0,
  ...overrides,
});

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: null,
  required: true,
});

type Detail = Parameters<typeof evaluatePullRequestWatch>[1];
const green: Detail = {
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: false,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    checksAlwaysReport: true,
  },
  headSha: "aaaaaaaaaa",
  checks: [check("test", "success")],
  mergeability: "mergeable",
  viewer: "agent-user",
  author: { login: "agent-user", name: null, avatarUrl: null },
};

const comment = (
  login: string,
  createdAt: string,
  overrides: Partial<PullRequestComment> = {},
): PullRequestComment => ({
  id: `${login}-${createdAt}`,
  kind: "issue-comment",
  author: { login, name: null, avatarUrl: null },
  body: "Status",
  createdAt,
  url: null,
  path: null,
  reviewState: null,
  ...overrides,
});

describe("pull request watch quiet period", () => {
  it("ends a green watch once nothing changed for the quiet period", () => {
    const passed = evaluatePullRequestWatch(watch(), green, [], atMs(0)).next;
    assert.isTrue(passed.passed);
    assert.equal(passed.changedAt, at(0));
    // A pass that sees nothing new keeps the time of the last change.
    const quietPass = evaluatePullRequestWatch(passed, green, [], atMs(10)).next;
    assert.equal(quietPass.changedAt, at(0));
    assert.isFalse(isPullRequestWatchQuiet(quietPass, Date.parse(at(14))));
    assert.isTrue(isPullRequestWatchQuiet(quietPass, Date.parse(at(15))));
  });

  it("restarts the quiet period on a new review or push", () => {
    const passed = evaluatePullRequestWatch(watch(), green, [], atMs(0)).next;
    const reviewed = evaluatePullRequestWatch(
      passed,
      green,
      [comment("office-of-the-cto", at(12), { kind: "review" })],
      atMs(13),
    ).next;
    assert.equal(reviewed.changedAt, at(13));
    assert.isFalse(isPullRequestWatchQuiet(reviewed, Date.parse(at(20))));
    const pushed = evaluatePullRequestWatch(
      reviewed,
      { ...green, headSha: "bbbbbbbbbb", checks: [check("test", "pending")] },
      [],
      atMs(25),
    ).next;
    assert.isFalse(pushed.passed);
    assert.isFalse(isPullRequestWatchQuiet(pushed, Date.parse(at(60))));
  });

  it("never ends a failing, conflicting, or legacy watch for being quiet", () => {
    const long = Date.parse(at(60));
    assert.isFalse(isPullRequestWatchQuiet(watch({ changedAt: at(0) }), long));
    assert.isFalse(
      isPullRequestWatchQuiet(watch({ passed: true, conflicting: true, changedAt: at(0) }), long),
    );
    // A watch saved before changedAt existed gets it on its next pass, not an early stop.
    assert.isFalse(isPullRequestWatchQuiet(watch({ passed: true }), long));
    assert.equal(evaluatePullRequestWatch(watch(), green, [], atMs(5)).next.changedAt, at(5));
  });

  it("does not wake for a bot rewriting its status comment, but does for a new one", () => {
    const vercel = { login: "vercel", name: null, avatarUrl: null, isBot: true };
    const passed = evaluatePullRequestWatch(
      watch(),
      green,
      [comment("vercel", at(-5), { author: vercel })],
      atMs(0),
    ).next;
    const edited = evaluatePullRequestWatch(
      passed,
      green,
      [comment("vercel", at(-5), { author: vercel, editedAt: at(8) })],
      atMs(9),
    );
    assert.deepEqual(edited.changes, []);
    assert.equal(edited.next.changedAt, at(0));

    const posted = evaluatePullRequestWatch(
      passed,
      green,
      [comment("vercel", at(-5), { author: vercel }), comment("vercel", at(8), { author: vercel })],
      atMs(9),
    );
    assert.equal(posted.changes.length, 1);
    // A person editing a comment is still news.
    const person = evaluatePullRequestWatch(
      passed,
      green,
      [comment("reviewer", at(-5), { editedAt: at(8) })],
      atMs(9),
    );
    assert.equal(person.changes.length, 1);
  });

  it("tells the agent watching ended and to hand the work back", () => {
    const message = pullRequestWatchQuietMessage({
      number: 12,
      url: "https://github.com/o/r/pull/12",
    });
    assert.include(message.text, `${PULL_REQUEST_WATCH_QUIET_MS / 60_000} minutes`);
    assert.include(message.text, "hand it back to the user");
    assert.equal(message.notification.summary, "#12: quiet, stopped watching");
  });
});
