import { assert, it } from "vite-plus/test";

import {
  type ActivityItem,
  OUTPUT_LIMIT,
  redactSecrets,
  TITLE_LIMIT,
  taskRow,
  noteRow,
  trimOutput,
  unwrapShell,
  waitsOnUser,
} from "./activity.ts";

const item = (fields: Partial<ActivityItem> & Pick<ActivityItem, "type">): ActivityItem => ({
  position: 7,
  itemId: "item-1",
  runId: "run-1",
  status: "completed",
  title: null,
  text: null,
  ...fields,
});

it("turns each kind of work into a task row", () => {
  const rows = [
    item({ type: "command_execution", status: "running", text: "$ pnpm test\nok 12 tests" }),
    item({
      type: "web_search",
      text: JSON.stringify({ patterns: ["slack chat.startStream"], results: [{}, {}, {}] }),
    }),
    item({ type: "file_search", text: JSON.stringify({ pattern: "TODO", results: [{}] }) }),
    item({ type: "file_change", text: "src/bridge.ts\n+12 -3\n@@ diff" }),
    item({ type: "todo_list", text: "[completed] Read the docs\n[in_progress] Write code" }),
    item({
      type: "dynamic_tool",
      status: "failed",
      text: JSON.stringify({ toolName: "chat_post", input: {}, output: {} }),
    }),
    item({ type: "subagent", status: "pending", title: "Review the diff" }),
  ].map(taskRow);
  assert.deepStrictEqual(
    rows.map((row) => [row?.title, row?.status, row?.output]),
    [
      ["Ran `pnpm test`", "in_progress", "ok 12 tests"],
      ["Searched the web for slack chat.startStream", "complete", "3 results"],
      ["Searched files for TODO", "complete", "1 match"],
      ["Edited src/bridge.ts", "complete", "+12 -3"],
      ["Updated the to-do list", "complete", "[completed] Read the docs\n[in_progress] Write code"],
      ["Called chat_post", "error", undefined],
      ["Subagent: Review the diff", "pending", undefined],
    ],
  );
  assert.strictEqual(rows[0]?.id, "item-1");
  assert.strictEqual(rows[0]?.order, 7);
});

it("names a command without its shell wrapper, and leaves out T3's own setup steps", () => {
  const wrapped = item({
    type: "command_execution",
    text: "$ /bin/bash -lc 'pnpm test --run'\nok",
  });
  assert.strictEqual(taskRow(wrapped)?.title, "Ran `pnpm test --run`");
  // Codex sends several commands as one script; the read shows its first line.
  const script = item({
    type: "command_execution",
    text: "$ /bin/bash -lc 'uname -a\ndate -u'\nLinux",
  });
  assert.strictEqual(taskRow(script)?.title, "Ran `uname -a …`");
  assert.strictEqual(unwrapShell(`zsh -c "ls -la"`), "ls -la");
  assert.strictEqual(unwrapShell("bash scripts/run.sh"), "bash scripts/run.sh");
  const setup = item({
    type: "command_execution",
    title: "Workspace ready",
    text: "$ Preparing workspace\nWorkspace preparation completed.",
  });
  assert.isUndefined(taskRow(setup));
  assert.strictEqual(
    taskRow(item({ type: "command_execution", title: "Installed dependencies", text: "$ pnpm i" }))
      ?.title,
    "Installed dependencies",
  );
});

it("shows reasoning as a short title, never its text", () => {
  const row = taskRow(
    item({
      type: "reasoning",
      status: "running",
      text: "**Checking the stream limits**\n\nThe docs say a stream lasts ten minutes, so I should…",
    }),
  );
  assert.strictEqual(row?.title, "Thinking: Checking the stream limits");
  assert.isUndefined(row?.output);
});

it("leaves out conversation and bookkeeping, and keeps unknown tool calls that have a title", () => {
  for (const type of ["assistant_message", "user_message", "checkpoint", "notification"]) {
    assert.isUndefined(taskRow(item({ type, text: "hello", title: "x" })));
  }
  assert.strictEqual(
    taskRow(item({ type: "new_tool", title: "Browsed a page" }))?.title,
    "Browsed a page",
  );
  assert.isUndefined(taskRow(item({ type: "new_tool" })));
});

it("marks requests that wait on a person", () => {
  assert.isTrue(waitsOnUser(item({ type: "user_input_request", status: "waiting" })));
  assert.isTrue(waitsOnUser(item({ type: "approval_request", status: "pending" })));
  assert.isFalse(waitsOnUser(item({ type: "approval_request", status: "completed" })));
  assert.isFalse(waitsOnUser(item({ type: "command_execution", status: "waiting" })));
});

it("redacts what looks like a secret and keeps what doesn't", () => {
  const text = [
    "export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuv",
    "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "curl -H 'Authorization: Bearer abc.def.ghijklmnopqrstu'",
    "postgres://app:hunter2secret@db.internal:5432/main",
    "AKIAABCDEFGHIJKLMNOP",
    "xoxb-1234-5678-abcdefghijkl",
    "password = correct-horse-battery",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
    "commit 6af69f6ceb72b459dc04594e04fe762dc251e383 passed",
  ].join("\n");
  const redacted = redactSecrets(text);
  for (const secret of [
    "sk-proj-abcdefghijklmnopqrstuv",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "abc.def.ghijklmnopqrstu",
    "hunter2secret",
    "AKIAABCDEFGHIJKLMNOP",
    "xoxb-1234-5678-abcdefghijkl",
    "correct-horse-battery",
    "MIIEow",
  ]) {
    assert.notInclude(redacted, secret);
  }
  assert.include(redacted, "6af69f6ceb72b459dc04594e04fe762dc251e383");
  assert.include(redacted, "export OPENAI_API_KEY=<redacted>");
});

it("redacts and trims row titles and outputs", () => {
  const row = taskRow(
    item({
      type: "command_execution",
      text: `$ deploy --token=abcdef123456 ${"x".repeat(200)}\n${"line\n".repeat(200)}done: ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
    }),
  );
  assert.notInclude(row?.title ?? "", "abcdef123456");
  assert.isAtMost(row?.title.length ?? 0, TITLE_LIMIT);
  assert.isAtMost(row?.output?.length ?? 0, OUTPUT_LIMIT);
  // Command output keeps its end, where the result is.
  assert.isTrue(row?.output?.endsWith("done: <redacted>"));
});

it("trims long text from the start or the end", () => {
  assert.strictEqual(trimOutput("abcdef", 4), "abc…");
  assert.strictEqual(trimOutput("abcdef", 4, "end"), "…def");
  assert.strictEqual(trimOutput("  short  ", 40), "short");
});

it("turns an agent message into a done row, redacted and on one line", () => {
  const note = noteRow(
    item({
      type: "assistant_message",
      text: "Checking the deploy.\nUsing token=abcdef123456 now.",
    }),
  );
  assert.deepStrictEqual(note, {
    id: "item-1",
    title: "Checking the deploy. Using token=<redacted> now.",
    status: "complete",
    order: 7,
  });
  assert.isUndefined(noteRow(item({ type: "assistant_message", text: "  " })));
});

it("names a tool call whose output was cut off", () => {
  const row = taskRow(
    item({
      type: "dynamic_tool",
      textTruncated: true,
      text: '{\n  "toolName": "t3-code.orchestrator_capabilities",\n  "input": {"search": "op',
    }),
  );
  assert.strictEqual(row?.title, "Called t3-code.orchestrator_capabilities");
});
