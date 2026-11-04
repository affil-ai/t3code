import { assert, it } from "vite-plus/test";

import type { TaskRow } from "./activity.ts";
import {
  FEEDBACK_ACTION_ID,
  planBlock,
  STREAM_MAX_MS,
  STREAM_TEXT_BUDGET,
  SlackRunDisplay,
  unsentAnswer,
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

const isFeedback = (block: any) =>
  block?.type === "context_actions" && block.elements?.[0]?.action_id === FEEDBACK_ACTION_ID;

it("streams a run's rows and text, and ends with feedback buttons on the stream", async () => {
  const slack = fakeSlack();
  const display = slack.display();
  await display.progress({ rows: [], text: "" });
  assert.deepStrictEqual(slack.calls, [], "nothing is posted before there is something to show");

  await display.progress({ rows: [row("a", "in_progress")], text: "" });
  await display.progress({ rows: [row("a", "in_progress")], text: "" });
  await display.progress({ rows: [row("a", "complete")], text: "Looking" });
  await display.finish({
    rows: [row("a", "complete")],
    text: "Looking\n\nThe answer is 4.",
    answer: "The answer is 4.",
  });

  assert.deepStrictEqual(slack.methods(), [
    "chat.startStream",
    "chat.appendStream",
    "chat.appendStream",
    "chat.stopStream",
  ]);
  const [start, row1, text, stop] = slack.calls;
  assert.strictEqual(start?.args.task_display_mode, "plan");
  assert.strictEqual(start?.args.thread_ts, "100.1");
  assert.deepStrictEqual(start?.args.chunks, [
    { type: "plan_update", title: "Working on it" },
    { type: "task_update", id: "a", title: "Step a", status: "in_progress" },
  ]);
  // An unchanged row is not sent again.
  assert.deepStrictEqual(row1?.args.chunks, [
    { type: "task_update", id: "a", title: "Step a", status: "complete" },
    { type: "markdown_text", text: "Looking" },
  ]);
  assert.deepStrictEqual(text?.args.chunks, [
    { type: "markdown_text", text: "\n\nThe answer is 4." },
  ]);
  assert.isTrue(isFeedback(stop?.args.blocks?.[0]));
  assert.deepStrictEqual(stop?.args.chunks, [{ type: "plan_update", title: "Done" }]);
});

it("streams a quick answer at the end, so even a run with no steps uses a stream", async () => {
  const slack = fakeSlack();
  await slack.display().finish({ rows: [], text: "Hi!", answer: "Hi!" });
  assert.deepStrictEqual(slack.methods(), ["chat.startStream", "chat.stopStream"]);
  assert.deepStrictEqual(slack.calls[0]?.args.chunks, [{ type: "markdown_text", text: "Hi!" }]);
  assert.isTrue(isFeedback(slack.calls[1]?.args.blocks?.[0]));
});

it("streams in a channel to the person who asked", async () => {
  const slack = fakeSlack("C1");
  await slack.display({ userId: "U1", teamId: "T1" }).progress({ rows: [], text: "Hi" });
  assert.strictEqual(slack.calls[0]?.args.recipient_user_id, "U1");
  assert.strictEqual(slack.calls[0]?.args.recipient_team_id, "T1");
});

it("uses a plan block where it can't stream, updated at a low rate", async () => {
  const slack = fakeSlack("C1");
  const display = slack.display();
  await display.progress({ rows: [row("a", "in_progress")], text: "" });
  await display.progress({ rows: [row("a", "complete"), row("b", "in_progress", 1)], text: "" });
  slack.advance(15_000);
  await display.progress({ rows: [row("a", "complete"), row("b", "in_progress", 1)], text: "" });
  await display.finish({
    rows: [row("a", "complete"), row("b", "in_progress", 1)],
    text: "Done.",
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
  assert.strictEqual(final?.args.blocks[0].title, "Done");
  // A finished run shows what was still going as done.
  assert.strictEqual(final?.args.blocks[0].tasks[1].status, "complete");
  assert.deepStrictEqual(answer?.args.blocks[0], { type: "markdown", text: "Done." });
  assert.isTrue(isFeedback(answer?.args.blocks[1]));
});

it("falls back to a plan block when Slack refuses the stream", async () => {
  const slack = fakeSlack();
  slack.refuse("chat.startStream", "feature_not_enabled");
  await slack.display().progress({ rows: [row("a", "in_progress")], text: "" });
  assert.deepStrictEqual(slack.methods(), ["chat.startStream", "chat.postMessage"]);
});

it("closes the stream before Slack's 10 minutes and goes on in a plan block", async () => {
  const slack = fakeSlack();
  const display = slack.display();
  await display.progress({ rows: [row("a", "in_progress")], text: "Starting." });
  slack.advance(STREAM_MAX_MS - 1);
  await display.progress({
    rows: [row("a", "in_progress"), row("b", "in_progress", 1)],
    text: "Starting.",
  });
  slack.advance(1);
  await display.progress({
    rows: [row("a", "in_progress"), row("b", "in_progress", 1)],
    text: "Starting.",
  });
  slack.advance(60_000);
  await display.finish({
    rows: [row("a", "complete"), row("b", "complete", 1)],
    text: "Starting.\n\nAll done after a long time.",
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
  assert.deepStrictEqual(
    close?.args.chunks.map((chunk: any) => [chunk.id, chunk.status]),
    [
      ["a", "complete"],
      ["b", "complete"],
    ],
  );
  assert.strictEqual(slack.calls[3]?.args.blocks[0].type, "plan");
  assert.strictEqual(slack.calls[4]?.args.blocks[0].title, "Done");
  const answer = slack.calls[5];
  assert.strictEqual(answer?.args.blocks[0].text, "All done after a long time.");
  assert.isTrue(isFeedback(answer?.args.blocks[1]));
});

it("posts the part of a long answer the stream had no room for", async () => {
  const slack = fakeSlack();
  const display = slack.display();
  const line = `${"x".repeat(99)}\n`;
  const answer = line.repeat(Math.ceil((STREAM_TEXT_BUDGET + 500) / line.length)).trim();
  await display.progress({ rows: [], text: answer });
  await display.finish({ rows: [], text: answer, answer });
  const streamed = slack.calls[0]?.args.chunks[0].text as string;
  assert.isAtMost(streamed.length, STREAM_TEXT_BUDGET);
  const stop = slack.calls.find((call) => call.method === "chat.stopStream");
  assert.isUndefined(stop?.args.blocks, "the feedback goes on the last part instead");
  const rest = slack.calls.filter((call) => call.method === "chat.postMessage");
  assert.lengthOf(rest, 1);
  assert.strictEqual(`${streamed}\n${rest[0]?.args.blocks[0].text}`, answer);
  assert.isTrue(isFeedback(rest[0]?.args.blocks[1]));
});

it("stops showing a run someone stopped, and posts only the notice", async () => {
  const slack = fakeSlack();
  const display = slack.display();
  await display.progress({ rows: [row("a", "in_progress")], text: "" });
  slack.refuse("chat.appendStream", "stopped_by_user");
  await display.progress({ rows: [row("a", "complete")], text: "" });
  await display.finish({
    rows: [row("a", "in_progress")],
    text: "",
    notice: "The run was stopped.",
  });
  assert.deepStrictEqual(slack.methods(), [
    "chat.startStream",
    "chat.appendStream",
    "chat.postMessage",
  ]);
  assert.strictEqual(slack.calls[2]?.args.blocks[0].text, "The run was stopped.");
  assert.lengthOf(slack.calls[2]?.args.blocks, 1, "no feedback buttons on a notice");
});

it("does not post an answer twice when a finish is retried", async () => {
  const slack = fakeSlack("C1");
  const display = slack.display();
  const answer = `${"a".repeat(11_000)}\n${"b".repeat(5_000)}`;
  slack.refuse("chat.postMessage", "ratelimited");
  await display.finish({ rows: [], text: answer, answer }).catch(() => {});
  await display.finish({ rows: [], text: answer, answer });
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

it("works out what of the answer the stream did not carry", () => {
  assert.strictEqual(unsentAnswer("Intro\n\nAns", "Intro\n\nAnswer", "Answer"), "wer");
  assert.strictEqual(unsentAnswer("Intro", "Intro\n\nAnswer", "Answer"), "Answer");
  assert.strictEqual(unsentAnswer("Intro\n\nAnswer", "Intro\n\nAnswer", "Answer"), "");
  // The text changed under the stream: post the answer unless the stream has it.
  assert.strictEqual(unsentAnswer("Other", "Intro\n\nAnswer", "Answer"), "Answer");
});
