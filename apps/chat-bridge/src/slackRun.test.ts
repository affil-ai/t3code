import { assert, it } from "vite-plus/test";

import type { TaskRow } from "./activity.ts";
import {
  planBlock,
  planTitle,
  slackTitle,
  STREAM_MAX_MS,
  STREAM_TEXT_BUDGET,
  SlackRunDisplay,
} from "./slackRun.ts";

type Call = { readonly method: string; readonly args: Record<string, any> };

/** A Slack Web API stand-in. `refuse` makes a method fail once with an error code. */
function fakeSlack(channel = "D1") {
  const calls: Array<Call> = [];
  const refusals = new Map<string, string>();
  let clock = 0;
  let ts = 0;
  const display = (recipient?: { userId: string; teamId: string }) =>
    new SlackRunDisplay({
      channel,
      threadTs: "100.1",
      recipient,
      now: () => clock,
      api: async (method, args) => {
        calls.push({ method, args });
        const code = refusals.get(method);
        if (code !== undefined) {
          refusals.delete(method);
          throw Object.assign(new Error(code), { data: { error: code } });
        }
        return { ok: true, ts: `200.${++ts}` };
      },
    });
  return {
    calls,
    display,
    methods: () => calls.map((call) => call.method),
    refuse: (method: string, code: string) => refusals.set(method, code),
    advance: (ms: number) => (clock += ms),
  };
}

const row = (id: string, status: TaskRow["status"], order = 0): TaskRow => ({
  id,
  title: `Step ${id}`,
  status,
  order,
});

it("streams a run's rows, then its answer as the reply's text", async () => {
  const slack = fakeSlack();
  const display = slack.display();
  await display.progress({ rows: [] });
  assert.deepStrictEqual(slack.calls, [], "nothing is posted before there is something to show");

  await display.progress({ rows: [row("a", "in_progress")] });
  await display.progress({ rows: [row("a", "in_progress")] });
  await display.progress({ rows: [row("a", "complete")] });
  await display.finish({ rows: [row("a", "complete")], answer: "The answer is 4." });

  assert.deepStrictEqual(slack.methods(), [
    "chat.startStream",
    "chat.appendStream",
    "chat.appendStream",
    "chat.stopStream",
  ]);
  const [start, done, answer, stop] = slack.calls;
  assert.strictEqual(start?.args.task_display_mode, "plan");
  assert.strictEqual(start?.args.thread_ts, "100.1");
  assert.deepStrictEqual(start?.args.chunks, [
    { type: "plan_update", title: "Working" },
    { type: "task_update", id: "a", title: "Step a", status: "in_progress" },
  ]);
  // An unchanged row is not sent again.
  assert.deepStrictEqual(done?.args.chunks, [
    { type: "task_update", id: "a", title: "Step a", status: "complete" },
  ]);
  assert.deepStrictEqual(answer?.args.chunks, [
    { type: "markdown_text", text: "The answer is 4." },
  ]);
  assert.deepStrictEqual(stop?.args.chunks, [{ type: "plan_update", title: "Completed 1 step" }]);
  assert.isUndefined(stop?.args.blocks, "no feedback buttons");
});

it("streams a quick answer with no plan", async () => {
  const slack = fakeSlack();
  await slack.display().finish({ rows: [], answer: "Hi!" });
  assert.deepStrictEqual(slack.methods(), ["chat.startStream", "chat.stopStream"]);
  assert.deepStrictEqual(slack.calls[0]?.args.chunks, [{ type: "markdown_text", text: "Hi!" }]);
  assert.deepStrictEqual(slack.calls[1]?.args, { channel: "D1", ts: "200.1" });
});

it("streams in a channel to the person who asked", async () => {
  const slack = fakeSlack("C1");
  await slack.display({ userId: "U1", teamId: "T1" }).progress({ rows: [row("a", "in_progress")] });
  assert.strictEqual(slack.calls[0]?.args.recipient_user_id, "U1");
  assert.strictEqual(slack.calls[0]?.args.recipient_team_id, "T1");
});

it("uses a plan block where it can't stream, updated at a low rate", async () => {
  const slack = fakeSlack("C1");
  const display = slack.display();
  await display.progress({ rows: [row("a", "in_progress")] });
  await display.progress({ rows: [row("a", "complete"), row("b", "in_progress", 1)] });
  slack.advance(15_000);
  await display.progress({ rows: [row("a", "complete"), row("b", "in_progress", 1)] });
  await display.finish({
    rows: [row("a", "complete"), row("b", "in_progress", 1)],
    answer: "Done.",
  });

  assert.deepStrictEqual(slack.methods(), [
    "chat.postMessage",
    "chat.update",
    "chat.update",
    "chat.postMessage",
  ]);
  const [first, update, final, answer] = slack.calls;
  assert.strictEqual(first?.args.blocks[0].type, "plan");
  assert.lengthOf(update?.args.blocks[0].tasks, 2);
  assert.strictEqual(final?.args.blocks[0].title, "Completed 2 steps");
  // A finished run shows what was still going as done.
  assert.strictEqual(final?.args.blocks[0].tasks[1].status, "complete");
  assert.deepStrictEqual(answer?.args.blocks, [{ type: "markdown", text: "Done." }]);
});

it("falls back to a plan block when Slack refuses the stream", async () => {
  const slack = fakeSlack();
  slack.refuse("chat.startStream", "feature_not_enabled");
  await slack.display().progress({ rows: [row("a", "in_progress")] });
  assert.deepStrictEqual(slack.methods(), ["chat.startStream", "chat.postMessage"]);
});

it("closes the stream before Slack's 10 minutes and goes on in a plan block", async () => {
  const slack = fakeSlack();
  const display = slack.display();
  await display.progress({ rows: [row("a", "in_progress")] });
  slack.advance(STREAM_MAX_MS - 1);
  await display.progress({ rows: [row("a", "in_progress"), row("b", "in_progress", 1)] });
  slack.advance(1);
  await display.progress({ rows: [row("a", "in_progress"), row("b", "in_progress", 1)] });
  slack.advance(60_000);
  await display.finish({
    rows: [row("a", "complete"), row("b", "complete", 1)],
    answer: "All done after a long time.",
  });

  assert.deepStrictEqual(slack.methods(), [
    "chat.startStream",
    "chat.appendStream",
    "chat.stopStream",
    "chat.postMessage",
    "chat.update",
    "chat.postMessage",
  ]);
  const close = slack.calls[2];
  assert.strictEqual(close?.args.session_status, "processing");
  // Steps still going stay in progress, with a pointer to the plan block.
  assert.deepStrictEqual(
    close?.args.chunks.map((chunk: any) => [chunk.id, chunk.status, chunk.output]),
    [
      ["a", "in_progress", "Continues in the next message."],
      ["b", "in_progress", "Continues in the next message."],
    ],
  );
  assert.strictEqual(slack.calls[3]?.args.text, "Working: 2 steps so far");
  assert.strictEqual(slack.calls[4]?.args.text, "Completed 2 steps");
  assert.strictEqual(slack.calls[3]?.args.blocks[0].type, "plan");
  assert.strictEqual(slack.calls[4]?.args.blocks[0].title, "Completed 2 steps");
  assert.deepStrictEqual(slack.calls[5]?.args.blocks, [
    { type: "markdown", text: "All done after a long time." },
  ]);
});

it("posts the part of a long answer the stream had no room for", async () => {
  const slack = fakeSlack();
  const line = `${"x".repeat(99)}\n`;
  const answer = line.repeat(Math.ceil((STREAM_TEXT_BUDGET + 500) / line.length)).trim();
  await slack.display().finish({ rows: [], answer });
  const streamed = slack.calls[0]?.args.chunks[0].text as string;
  assert.isAtMost(streamed.length, STREAM_TEXT_BUDGET);
  const rest = slack.calls.filter((call) => call.method === "chat.postMessage");
  assert.lengthOf(rest, 1);
  assert.strictEqual(`${streamed}\n${rest[0]?.args.blocks[0].text}`, answer);
});

it("stops showing a run someone stopped, and posts only the notice", async () => {
  const slack = fakeSlack();
  const display = slack.display();
  await display.progress({ rows: [row("a", "in_progress")] });
  slack.refuse("chat.appendStream", "stopped_by_user");
  await display.progress({ rows: [row("a", "complete")] });
  await display.finish({ rows: [row("a", "in_progress")], notice: "The run was stopped." });
  assert.deepStrictEqual(slack.methods(), [
    "chat.startStream",
    "chat.appendStream",
    "chat.postMessage",
  ]);
  assert.deepStrictEqual(slack.calls[2]?.args.blocks, [
    { type: "markdown", text: "The run was stopped." },
  ]);
});

it("does not post an answer twice when a finish is retried", async () => {
  const slack = fakeSlack("C1");
  const display = slack.display();
  const answer = `${"a".repeat(11_000)}\n${"b".repeat(5_000)}`;
  slack.refuse("chat.postMessage", "ratelimited");
  await display.finish({ rows: [], answer }).catch(() => {});
  await display.finish({ rows: [], answer });
  const posts = slack.calls.filter((call) => call.method === "chat.postMessage");
  // The first part failed once, then both parts were posted once.
  assert.lengthOf(posts, 3);
});

it("folds the oldest rows of a long plan into one", () => {
  const rows = Array.from({ length: 60 }, (_, index) => row(String(index), "complete", index));
  const block = planBlock(rows, "Working on it") as {
    tasks: Array<{ task_id: string; title: string }>;
  };
  assert.lengthOf(block.tasks, 50);
  assert.deepStrictEqual(block.tasks[0], {
    task_id: "earlier",
    title: "11 earlier steps",
    status: "complete",
  } as never);
  assert.strictEqual(block.tasks[49]?.task_id, "59");
});

it("titles the plan by what the run did", () => {
  assert.strictEqual(planTitle(3, false, false), "Working");
  assert.strictEqual(planTitle(1, true, false), "Completed 1 step");
  assert.strictEqual(planTitle(4, true, true), "Stopped after 4 steps");
});

it("makes titles Slack accepts", () => {
  // Slack answered invalid_name for titles with square brackets (2026-11-04).
  assert.strictEqual(
    slackTitle("[t3 bridge test] What is 17 times 23? Reply with just the number."),
    "t3 bridge test What is 17 times 23? Reply with just the number.",
  );
  assert.strictEqual(slackTitle("Fix `ci` #42 <now> ✅", true), "Fix ci 42 now");
  // Slack answered invalid_name for a colon too.
  assert.strictEqual(
    slackTitle("test E falcon: Find where the map fetches hotel…"),
    "test E falcon - Find where the map fetches hotel…",
  );
  assert.strictEqual(slackTitle("a: b", true), "a b");
  assert.strictEqual(slackTitle("x".repeat(300)).length, 200);
});
