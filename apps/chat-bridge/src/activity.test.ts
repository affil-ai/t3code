import { assert, it } from "vite-plus/test";

import {
  type ActivityItem,
  currentStatus,
  isPermissionRequest,
  isQuestion,
  redactSecrets,
  STATUS_LIMIT,
  finishedStep,
  planOf,
  statusLine,
  unwrapShell,
} from "./activity.ts";

const item = (fields: Partial<ActivityItem> & Pick<ActivityItem, "type">): ActivityItem => ({
  position: 7,
  itemId: "item-1",
  runId: "run-1",
  status: "running",
  title: null,
  text: null,
  ...fields,
});

it("says what each kind of work is doing, in the present tense", () => {
  const lines = [
    item({ type: "command_execution", text: "$ /bin/bash -lc 'pnpm test --run'\nok" }),
    item({ type: "command_execution", text: "$ /bin/bash -lc 'uname -a\ndate -u'" }),
    item({
      type: "web_search",
      text: JSON.stringify({ patterns: ["slack streams"], results: [] }),
    }),
    item({ type: "file_search", text: JSON.stringify({ pattern: "TODO", results: [] }) }),
    item({ type: "file_change", text: "src/bridge.ts\n+12 -3" }),
    item({ type: "todo_list", text: "[in_progress] Write code" }),
    item({ type: "dynamic_tool", text: JSON.stringify({ toolName: "t3-chat-bridge.chat_post" }) }),
    item({ type: "reasoning", text: "**Checking the stream limits**\n\nThe docs say…" }),
    item({ type: "reasoning", text: "" }),
  ].map(statusLine);
  assert.deepStrictEqual(lines, [
    "Running `pnpm test --run`",
    "Running `uname -a …`",
    "Searching the web for slack streams",
    "Searching files for TODO",
    "Editing src/bridge.ts",
    "Planning",
    "Using chat post",
    "Checking the stream limits",
    "Thinking…",
  ]);
});

it("names a tool call whose output was cut off", () => {
  const line = statusLine(
    item({
      type: "dynamic_tool",
      textTruncated: true,
      text: '{\n  "toolName": "t3-code.orchestrator_capabilities",\n  "input": {"search": "op',
    }),
  );
  assert.strictEqual(line, "Using orchestrator capabilities");
});

it("leaves out conversation, bookkeeping and T3's own setup", () => {
  for (const type of ["assistant_message", "user_message", "checkpoint", "notification"]) {
    assert.isUndefined(statusLine(item({ type, text: "hello", title: "x" })));
  }
  const setup = item({
    type: "command_execution",
    title: "Workspace ready",
    text: "$ Preparing workspace\nWorkspace preparation completed.",
  });
  assert.isUndefined(statusLine(setup));
  assert.strictEqual(unwrapShell(`zsh -c "ls -la"`), "ls -la");
  assert.strictEqual(unwrapShell("bash scripts/run.sh"), "bash scripts/run.sh");
});

it("shows the newest step still going, and thinking between steps", () => {
  const done = item({ type: "command_execution", status: "completed", text: "$ ls" });
  const going = item({
    type: "web_search",
    position: 9,
    text: JSON.stringify({ patterns: ["x"] }),
  });
  assert.strictEqual(currentStatus([done]), "Thinking…");
  assert.strictEqual(currentStatus([done, going]), "Searching the web for x");
  assert.strictEqual(currentStatus([]), "Thinking…");
});

it("keeps the status short and free of secrets", () => {
  const line = statusLine(
    item({
      type: "command_execution",
      text: "$ deploy --token=abcdef123456 --region us-east-1 --verbose",
    }),
  );
  assert.notInclude(line ?? "", "abcdef123456");
  assert.isAtMost(line?.length ?? 0, STATUS_LIMIT);
});

it("tells questions and permission requests apart", () => {
  assert.isTrue(isQuestion(item({ type: "user_input_request", status: "waiting" })));
  assert.isFalse(isQuestion(item({ type: "user_input_request", status: "completed" })));
  assert.isTrue(isPermissionRequest(item({ type: "approval_request", status: "pending" })));
  assert.isFalse(isPermissionRequest(item({ type: "command_execution", status: "waiting" })));
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

it("describes a finished step without its output, with secrets redacted, and nothing while it runs", () => {
  const command = item({
    type: "command_execution",
    status: "completed",
    text: "$ /bin/bash -lc 'curl -H \"Authorization: Bearer abcdefghijklmnop1234\" https://x'\nsecret file contents",
  });
  const step = finishedStep(command)!;
  assert.strictEqual(step.action, "Ran");
  assert.notInclude(step.parameter, "abcdefghijklmnop1234");
  assert.notInclude(JSON.stringify(step), "secret file contents");
  assert.strictEqual(step.result, "Done");
  assert.isUndefined(finishedStep({ ...command, status: "running" }));
  assert.isUndefined(finishedStep(item({ type: "reasoning", status: "completed" })));
  assert.deepStrictEqual(
    finishedStep(item({ type: "file_change", status: "failed", text: "src/a.ts\n+secret" })),
    { itemId: command.itemId, action: "Edited", parameter: "src/a.ts", result: "Failed" },
  );
});

it("reads a to-do list as the run's plan, not as a step", () => {
  const todo = item({
    type: "todo_list",
    status: "completed",
    text: "Checking the project\n[completed] check date\n[running] list files with token=abcdef123456\n[pending] read README",
  });
  assert.deepStrictEqual(planOf(todo), [
    { status: "completed", text: "check date" },
    { status: "running", text: "list files with token=<redacted>" },
    { status: "pending", text: "read README" },
  ]);
  assert.isUndefined(finishedStep(todo));
  assert.isUndefined(planOf({ ...todo, textTruncated: true }));
  assert.isUndefined(planOf(item({ type: "reasoning", text: "[pending] x" })));
});
