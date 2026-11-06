import { assert, it } from "vite-plus/test";

import type { ActivityItem } from "../activity.ts";
import type { T3Threads } from "../threads.ts";
import { type Claim, type OfficeApi, OfficeConvexError, type PendingWork } from "./convex.ts";
import { formatRequest } from "./message.ts";
import { OfficeRuntime } from "./runtime.ts";
import { timelineEntry } from "./timeline.ts";

const item = (overrides: Partial<ActivityItem>): ActivityItem => ({
  position: 10,
  itemId: "item-1",
  type: "command_execution",
  runId: "t3-run-1",
  status: "completed",
  title: null,
  text: "$ pnpm test\nall 12 passed",
  ...overrides,
});

it("shows a command as a step: the command, then its output once it ends", () => {
  const running = timelineEntry(item({ status: "running", text: "$ pnpm test\npartial" }))!;
  const later = timelineEntry(item({ status: "running", text: "$ pnpm test\nmore output" }))!;
  const done = timelineEntry(item({}))!;
  assert.strictEqual(running.item.type, "work_log");
  // A step still going is sent with only what can't change, so a re-read gives the same digest.
  assert.strictEqual(running.digest, later.digest);
  assert.strictEqual(running.seqEnd, 41);
  assert.strictEqual(done.seqEnd, 42);
  assert.deepInclude(done.item, {
    label: "Ran pnpm test",
    command: "pnpm test",
    detail: "all 12 passed",
    toolLifecycleStatus: "completed",
  });
});

it("shows a tool call with its input and output, redacted and cut short", () => {
  const text = JSON.stringify({
    toolName: "mcp__executor__execute",
    input: { query: "token=sk-live-abcdefghijklmnopqrstu" },
    output: "x".repeat(5_000),
  });
  const entry = timelineEntry(item({ type: "dynamic_tool", text }))!;
  assert.strictEqual(entry.item.type, "tool_call");
  if (entry.item.type !== "tool_call") return;
  assert.strictEqual(entry.item.name, "mcp__executor__execute");
  assert.notInclude(entry.item.inputJson, "abcdefghijklmnop");
  assert.isBelow(entry.item.outputJson!.length, 2_100);
  assert.strictEqual(entry.item.status, "completed");
});

it("sends an answer only once it is done, with its whole text", () => {
  const answer = item({ type: "assistant_message", text: "Done" });
  assert.isUndefined(timelineEntry({ ...answer, status: "running" }, "Do"));
  assert.deepInclude(timelineEntry(answer, "Done, all passed.")!.item, {
    type: "assistant_message",
    text: "Done, all passed.",
  });
  // The person's own message and T3's workspace setup aren't Office steps.
  assert.isUndefined(timelineEntry(item({ type: "user_message", text: "hi" })));
  assert.isUndefined(
    timelineEntry(item({ title: "Workspace ready", text: "$ Preparing workspace" })),
  );
});

it("names the requester and the commit trailer, and the rules only on a new chat", () => {
  const claim = {
    kind: "provision",
    actor: { externalUserId: "m1", displayName: "Ada <x>", email: "ADA@affil.ai" },
    message: { markdown: "Fix the build", files: [] },
  } as unknown as Claim;
  const text = formatRequest(claim);
  assert.include(text, "Office request from Ada x <ada@affil.ai>:\n\nFix the build");
  assert.include(text, "Co-authored-by: Ada x <ada@affil.ai>");
  assert.include(text, "office-github-conventions");
  assert.notInclude(formatRequest({ ...claim, kind: "dispatch" }), "office-github-conventions");
});

function harness(options: { refuse?: (event: Record<string, unknown>) => boolean } = {}) {
  const posted: Array<Record<string, unknown>> = [];
  const logs: Array<string> = [];
  let pending: PendingWork = {
    provisions: [{ runId: "run-1", bindingId: "b1", receiptId: "r1" }],
    dispatches: [],
    cancels: [],
    subscriptions: [],
  };
  let items: Array<ActivityItem> = [];
  let status = "running";
  const sent: Array<{ text: string; requestId: string }> = [];
  const office: OfficeApi = {
    pendingWork: async () => pending,
    claimWork: async () =>
      ({
        kind: "provision",
        runId: "run-1",
        bindingId: "b1",
        receiptId: "r1",
        attempt: 1,
        title: "Fix the build",
        actor: { externalUserId: "m1", displayName: "Ada", email: "ada@affil.ai" },
        message: { markdown: "Fix the build", files: [] },
      }) as Claim,
    reportPreDispatchFailure: async () => "retrying",
    postEvents: async (events) => {
      if (events.some((event) => options.refuse?.(event) === true))
        throw new OfficeConvexError("agentHost:postEvents", "AGENT_ITEM_CONFLICT", undefined);
      posted.push(...events);
      return events.map(() => ({ outcome: "applied" as const }));
    },
  };
  const threads = {
    importFiles: async () => ({ attachments: [], skipped: [] }),
    start: async (input: { text: string; requestId: string }) => {
      sent.push(input);
      return { threadId: "t3-thread", runId: "t3-run-1" };
    },
    send: async () => ({ runId: "t3-run-2", delivery: "started" }),
    activity: async () => ({ title: "", pendingRequests: 0, items, lastPosition: 99 }),
    itemText: async () => "The build passes now.",
    waitForRun: async (_threadId: string, runId: string) => ({ runId, status, timedOut: true }),
    interrupt: async () => {},
    shape: async () => ({ latestRun: undefined }),
  } as unknown as T3Threads;
  const runtime = new OfficeRuntime({
    office,
    threads,
    projectId: "p",
    environmentId: "chat-bridge",
    defaultModel: { instanceId: "claudeAgent" },
    log: (line) => void logs.push(line),
    now: () => 1_000,
  });
  return {
    runtime,
    posted,
    logs,
    sent,
    setPending: (next: PendingWork) => (pending = next),
    setItems: (next: Array<ActivityItem>) => (items = next),
    setStatus: (next: string) => (status = next),
  };
}

const kinds = (posted: ReadonlyArray<Record<string, unknown>>) =>
  posted.map(
    (event) =>
      `${String(event.kind)}${event.itemKey ? `:${String(event.itemKey)}:${String(event.seqEnd)}` : ""}`,
  );

it("starts a queued chat in T3, reports each step and the answer, then the end", async () => {
  const run = harness();
  await run.runtime.tick();
  assert.include(run.sent[0]!.text, "Office request from Ada <ada@affil.ai>");
  assert.strictEqual(run.sent[0]!.requestId, "office:r1:0");
  assert.deepInclude(run.posted[0]!, {
    kind: "accepted",
    agentId: "t3-thread",
    providerTurnId: "t3-run-1",
    runId: "run-1",
    receiptId: "r1",
  });

  run.setPending({ provisions: [], dispatches: [], cancels: [], subscriptions: [] });
  run.setItems([item({ status: "running" })]);
  await run.runtime.tick();
  run.setItems([
    item({}),
    item({
      position: 11,
      itemId: "answer",
      type: "assistant_message",
      text: "The build",
      textTruncated: true,
    }),
  ]);
  run.setStatus("completed");
  await run.runtime.tick();
  // A repeated pass sends nothing new.
  await run.runtime.tick();
  assert.deepStrictEqual(kinds(run.posted), [
    "accepted",
    "timeline:item-1:41",
    "timeline:item-1:42",
    "timeline:answer:46",
    "completed",
  ]);
  assert.deepInclude(run.posted[3]!.item as object, { text: "The build passes now." });
  assert.deepInclude(run.posted[4]!, { finalItemKey: "answer", providerTurnId: "t3-run-1" });
});

it("skips an event Office refuses and still sends the others", async () => {
  const run = harness({ refuse: (event) => event.itemKey === "bad" });
  await run.runtime.tick();
  run.setPending({ provisions: [], dispatches: [], cancels: [], subscriptions: [] });
  run.setItems([item({ itemId: "bad" }), item({ position: 12, itemId: "good" })]);
  await run.runtime.tick();
  assert.deepStrictEqual(kinds(run.posted), ["accepted", "timeline:good:50"]);
  assert.include(run.logs.join("\n"), "refused timeline:bad:42");
});

it("picks up a turn Office is still waiting on after a restart", async () => {
  const run = harness();
  run.setPending({
    provisions: [],
    dispatches: [],
    cancels: [],
    subscriptions: [
      { bindingId: "b1", threadId: "t3-thread", activeProviderTurnIds: ["t3-run-1"] },
    ],
  });
  run.setItems([
    item({ position: 11, itemId: "answer", type: "assistant_message", text: "Done." }),
  ]);
  run.setStatus("completed");
  await run.runtime.tick();
  assert.deepStrictEqual(kinds(run.posted), ["timeline:answer:46", "completed"]);
});
