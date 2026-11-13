import * as NodeSqlite from "node:sqlite";

import { assert, it } from "vite-plus/test";

import {
  Bridge,
  BARE_MENTION_REQUEST,
  BOUND_BARE_MENTION_REQUEST,
  type EarlierMessage,
  earlierText,
  type ChannelRoute,
  type InboundEvent,
  type InboundReaction,
  routeFor,
  threadTitle,
  type BlockMessage,
  type Reply,
  WORK_RUNNING_NOTE,
} from "./bridge.ts";
import type { PlanStep, RunStep } from "./activity.ts";
import {
  ACKNOWLEDGE_FIRST,
  BACKGROUND_STATUS,
  type ChatPlatform,
  isQuietReply,
  type OutboundMessage,
  QUIET_REPLY,
  type ThreadRoute,
} from "./platform.ts";
import { SLACK_REPLY_STYLE, slackFirstTurnNote, slackPlatform } from "./slack/platform.ts";
import { imessagePlatform } from "./imessage/platform.ts";
import type { ImessageAdapter } from "./imessage/adapter.ts";
import { startChatHost } from "./chatHost.ts";
import { createChatState } from "./chatState.ts";
import type { Chat } from "chat";
import { createSlackHost, type SlackTransport } from "./slack/host.ts";
import { fakeSlackApi } from "./slack/fakeSlackApi.ts";
import { resendSlackMessage, RUNNING_PID_KEY, runningBridge } from "./slack/resend.ts";
import { startSlackThread } from "./slack/start.ts";
import { callTool } from "./toolServer.ts";
import {
  connectSlackRelay,
  currentRelayedRow,
  isChatSdkDedupeKey,
  type SlackInboxRow,
} from "./slack/relay.ts";
import { BridgeStore, ensureSchema } from "./store.ts";
import type { T3Tools } from "./t3Client.ts";
import { type RunStatus, T3Threads } from "./threads.ts";

/** Slack's wording, for helpers that format text without a connection. */
const SLACK = slackPlatform({
  host: () => undefined,
  access: { allowedUserIds: [] },
  channelRoutes: [],
});

const PROJECT = "project-1";
/** How often the bridge looks for runs T3 started with a notification. */
const NOTIFICATION_POLL_MS = 20_000;
const THREAD = "thread-1";

/** A T3 server stand-in. Runs end when the test calls `finish`. */
function fakeT3() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const answers = new Map<string, string>();
  const ended = new Map<string, { status: RunStatus; resolve: () => void; done: Promise<void> }>();
  /** Launches by retry key, as T3 keeps them, so a retried launch returns the same thread. */
  const launches = new Map<string, { threadId: string; runId: string }>();
  /** Calls to fail or never answer, by tool, before the next one succeeds. */
  const failures = new Map<string, number>();
  /** Calls that never answer, each with what to tell the test once one arrives. */
  const hangs = new Map<string, () => void>();
  /** Attachment sends T3 accepted, by retry key, with the run each joined. */
  const attachmentSends = new Map<string, string>();
  /** Activity items besides the answers, and the thread as a read shows it. */
  const activity: Array<Record<string, unknown>> = [];
  const thread = { title: "fix the build", pendingRequestCount: 0 };
  /** Questions T3 waits on, by request id. */
  const questions = new Map<string, ReadonlyArray<Record<string, unknown>>>();
  /** Older T3 servers name one pending-request tool per action. */
  const options: {
    splitPendingTools: boolean;
    answerStartsRun?: string;
    /** A subagent reports back after the run ends: T3 starts this run with a notification. */
    delegatedWakes?: string | undefined;
    /** T3 calls the work settled before it records the waking run. */
    wakeAfterSettled?: boolean;
    /** The run ended as the message arrived, so T3 starts a new one instead of steering. */
    sendStartsRun?: boolean;
    /** Subagents or background work still running: each wait for them times out at the next tick. */
    delegatedPending?: boolean;
    /** Runs whose own delegated work is still running, in place of `delegatedPending` for every run. */
    delegatedPendingRuns?: Set<string>;
    /** The runs a thread read lists, as for a subagent the bridge didn't start. */
    recentRuns?: ReadonlyArray<{
      runId: string;
      ordinal: number;
      status: RunStatus;
      requestedAt?: string;
    }>;
    /** T3 accepts the next attachment send, and its reply is lost on the way back. */
    loseAttachmentReply?: boolean;
    /**
     * Reads return only the items after `afterPosition`, as T3's do. Off by default:
     * answers are listed before `later`, so most tests' positions move as runs answer.
     */
    pagedReads?: boolean;
    /** When the thread last changed, as `t3_thread_list` shows it. */
    updatedAt?: string;
  } = {
    splitPendingTools: false,
  };
  /** Items T3 adds after the answers, such as a wake-up's notification. */
  const later: Array<Record<string, unknown>> = [];
  /** Runs before each activity read, to add items between reads. */
  let beforeRead = () => {};
  let modelSelection: Record<string, unknown> = {
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
  };
  /** Waits in flight end as timed out when the test calls `tick`. */
  let tickNow = () => {};
  let ticked = new Promise<void>((resolve) => (tickNow = resolve));
  /** Resolved by the next `t3_thread_wait` call: the watcher has finished its check. */
  let waitCalled = () => {};
  let runs = 0;
  const run = (runId: string) => {
    let entry = ended.get(runId);
    if (entry === undefined) {
      let resolve = () => {};
      const done = new Promise<void>((each) => (resolve = each));
      entry = { status: "running", resolve, done };
      ended.set(runId, entry);
    }
    return entry;
  };
  const tools: T3Tools = {
    upload: async () => {},
    call: async <T>(called: string, input: Record<string, unknown>) => {
      calls.push({ tool: called, args: input });
      let tool = called;
      let args = input;
      if (options.splitPendingTools) {
        if (tool === "t3_pending_request") {
          throw new Error("MCP error -32602: Tool 't3_pending_request' not found");
        }
        const action = /^t3_pending_request_(\w+)$/.exec(tool)?.[1];
        if (action !== undefined) {
          tool = "t3_pending_request";
          args = { ...input, action };
        }
      }
      const hung = hangs.get(tool);
      if (hung !== undefined) {
        hangs.delete(tool);
        hung();
        return new Promise<T>(() => {});
      }
      const failing = failures.get(tool) ?? 0;
      if (failing > 0) {
        failures.set(tool, failing - 1);
        throw new Error("T3 is unavailable");
      }
      const result = (() => {
        switch (tool) {
          case "t3_thread_launch": {
            const key = String(args.clientRequestId);
            const launch = launches.get(key) ?? { threadId: THREAD, runId: `run-${++runs}` };
            launches.set(key, launch);
            return launch;
          }
          case "t3_attachment_prepare_upload":
            return { attachmentId: `attachment-${calls.length}`, relativeUrl: "/upload" };
          case "t3_thread_send_attachments": {
            // A retry with the same key returns the message the first send made.
            const key =
              args.clientRequestId === undefined ? undefined : String(args.clientRequestId);
            const runId = (key && attachmentSends.get(key)) || `run-${runs}`;
            attachmentSends.set(key ?? `unkeyed-${calls.length}`, runId);
            if (options.loseAttachmentReply === true) {
              options.loseAttachmentReply = false;
              throw new Error("socket hang up");
            }
            return { threadId: THREAD, runId, status: "running" };
          }
          case "t3_thread_send":
            if (args.mode !== "auto") throw new Error("the bridge always sends with auto");
            // T3 steers the run in flight, or starts one if it has just ended.
            if (options.sendStartsRun === true)
              return { runId: `run-${++runs}`, delivery: "started" };
            return { runId: `run-${runs}`, delivery: "steered" };
          case "t3_thread_wait": {
            if (args.untilDelegatedWorkSettled === true) {
              const pending =
                options.delegatedPendingRuns?.has(String(args.runId)) ??
                options.delegatedPending === true;
              // A zero timeout only reads whether the work is still going.
              if (args.timeoutMs === 0)
                return { runId: args.runId, status: "completed", timedOut: pending };
              if (pending) {
                waitCalled();
                return ticked.then(() => ({
                  runId: args.runId,
                  status: "running",
                  timedOut: true,
                }));
              }
              if (options.wakeAfterSettled === true && options.delegatedWakes !== undefined) {
                // The next activity read still misses it; the one after sees it.
                const wake = options.delegatedWakes;
                options.delegatedWakes = undefined;
                let reads = 0;
                beforeRead = () => {
                  reads += 1;
                  if (reads !== 2) return;
                  later.push({
                    itemId: `wake-${wake}`,
                    type: "notification",
                    runId: wake,
                    status: "completed",
                  });
                };
                return { runId: args.runId, status: "completed", timedOut: false };
              }
              if (options.delegatedWakes !== undefined) {
                later.push({
                  itemId: `wake-${options.delegatedWakes}`,
                  type: "notification",
                  runId: options.delegatedWakes,
                  status: "completed",
                });
                options.delegatedWakes = undefined;
              }
              return { runId: args.runId, status: "completed", timedOut: false };
            }
            const entry = run(String(args.runId));
            // A zero timeout only reads the status; it isn't the watcher waiting.
            if (args.timeoutMs === 0) {
              return {
                runId: args.runId,
                status: entry.status,
                timedOut: entry.status !== "completed",
              };
            }
            waitCalled();
            return Promise.race([
              entry.done.then(() => ({ runId: args.runId, status: entry.status, timedOut: false })),
              ticked.then(() => ({ runId: args.runId, status: "running", timedOut: true })),
            ]);
          }
          case "t3_thread_configure":
            if (args.modelSelection !== undefined) {
              modelSelection = args.modelSelection as Record<string, unknown>;
              return { sequence: 1 };
            }
            return { threadId: args.threadId, modelSelection };
          case "t3_thread_update":
          case "t3_thread_interrupt":
            return { threadId: args.threadId };
          case "t3_pending_request":
            if (args.action === "list") return { requestIds: [...questions.keys()] };
            if (args.action === "read") {
              return {
                requestId: args.requestId,
                questions: questions.get(String(args.requestId)),
              };
            }
            questions.delete(String(args.requestId));
            // Codex's question ends its run; T3 hands the answer to a new one.
            if (options.answerStartsRun !== undefined) {
              activity.push({
                itemId: `answer-${options.answerStartsRun}`,
                type: "user_message",
                runId: options.answerStartsRun,
                status: "completed",
              });
            }
            return { sequence: 1 };
          case "t3_thread_list":
            // Newest first, as T3 lists them; the harness's thread is always the newest.
            return {
              projectId: null,
              currentThreadId: null,
              threads: [
                {
                  threadId: THREAD,
                  latestRunId: runs === 0 ? null : `run-${runs}`,
                  updatedAt: options.updatedAt ?? "1970-01-01T00:00:00.000Z",
                },
              ],
              nextCursor: null,
              total: 1,
            };
          case "t3_thread_read": {
            if (args.view === "activity" && args.itemId === undefined) beforeRead();
            if (args.itemId !== undefined) {
              const runId = String(args.itemId).replace("item-", "");
              return { thread: {}, items: [{ itemId: args.itemId, text: answers.get(runId) }] };
            }
            const answerItems = [...answers.keys()].map((runId) => ({
              itemId: `item-${runId}`,
              type: "assistant_message",
              runId,
              text: "x",
            }));
            const all = [...activity, ...answerItems, ...later].map((item, position) => ({
              position,
              ...item,
            }));
            const after =
              options.pagedReads === true && typeof args.afterPosition === "number"
                ? args.afterPosition
                : -1;
            const items = all.filter((item) => item.position > after);
            return {
              thread: { ...thread, itemCount: all.length },
              recentRuns: options.recentRuns ?? [],
              items,
              nextPosition: null,
              hasMore: false,
            };
          }
          default:
            throw new Error(`unexpected ${tool}`);
        }
      })();
      return (await result) as T;
    },
  };
  return {
    tools,
    calls,
    activity,
    later,
    thread,
    questions,
    options,
    attachmentSends,
    /**
     * Ends the waits in flight as timed out, and resolves once the watcher has
     * checked the run's activity and is waiting again.
     */
    tick: async () => {
      const waiting = new Promise<void>((resolve) => (waitCalled = resolve));
      tickNow();
      ticked = new Promise<void>((resolve) => (tickNow = resolve));
      await waiting;
    },
    fail: (tool: string, times: number) => failures.set(tool, times),
    /** The next call to `tool` never answers; resolves once it arrives. */
    hang: (tool: string) => new Promise<void>((resolve) => hangs.set(tool, resolve)),
    /** Sets a run's status without ending it, such as "starting". */
    setStatus: (runId: string, status: RunStatus) => {
      run(runId).status = status;
    },
    finish: (runId: string, status: RunStatus, answer?: string) => {
      if (answer !== undefined) answers.set(runId, answer);
      const entry = run(runId);
      entry.status = status;
      entry.resolve();
    },
  };
}

function freshDatabase(): NodeSqlite.DatabaseSync {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  ensureSchema(db);
  return db;
}

function harness(
  db = freshDatabase(),
  options: {
    directRoute?: ThreadRoute;
    post?: (reply: Reply) => Promise<void>;
    history?: () => Promise<ReadonlyArray<EarlierMessage>>;
    /** Renames to the chat thread fail this many times before they succeed. */
    renameFailures?: number;
    routes?: ReadonlyArray<ChannelRoute>;
    allowEveryone?: boolean;
    /** Full workspace members, for `allowEveryone`. */
    members?: ReadonlyArray<string>;
    /** The platform lists each finished step and shows the plan, as Linear does. */
    steps?: boolean;
    /** The platform has no buttons, as Linear and iMessage don't. */
    noButtons?: boolean;
    /** Posting a question with buttons fails this many times before it succeeds. */
    questionPostFailures?: number;
    sleep?: (ms: number) => Promise<void>;
    /** The same T3 as another harness's, such as across a restart. */
    t3?: ReturnType<typeof fakeT3>;
    now?: () => number;
    /** Told when each run and its delegated work end, as Office's article staging is. */
    runEnded?: ChatPlatform["runEnded"];
    /** Another platform served beside Slack, such as Office's channel. */
    otherPlatform?: ChatPlatform;
    /** Slack calls to take from elsewhere, such as the real Slack host's. */
    slack?: Partial<ChatPlatform>;
  } = {},
) {
  const blockPosts: Array<BlockMessage & { messageId?: string }> = [];
  const renamed: Array<string> = [];
  let renameFailures = options.renameFailures ?? 0;
  let questionPostFailures = options.questionPostFailures ?? 0;
  const t3 = options.t3 ?? fakeT3();
  const posted: Array<Reply & { readonly kind?: string }> = [];
  const statuses: Array<string> = [];
  const steps: Array<string> = [];
  const plans: Array<string> = [];
  const store = new BridgeStore(db);
  let clock = 0;
  const scheduled: Array<number> = [];
  /** What each schedule runs, for tests that move time on themselves. */
  const scheduledRuns: Array<{ readonly ms: number; readonly run: () => void }> = [];
  const downloads: Array<string> = [];
  const quieted: Array<string> = [];
  const bridge = new Bridge({
    store,
    threads: new T3Threads(t3.tools),
    settings: {},
    platforms: [
      {
        id: "slack",
        name: "Slack",
        place: "Slack thread",
        access: { allowedUserIds: ["U1"], allowEveryone: options.allowEveryone },
        isEligible: async (userId) => (options.members ?? []).includes(userId),
        channelRoutes: options.routes ?? [{ channelId: "C1", projectId: PROJECT }],
        directRoute: options.directRoute,
        person: (userId, name) => `${name} (<@${userId}>)`,
        firstTurnNote: slackFirstTurnNote,
        replyStyle: SLACK_REPLY_STYLE,
        refusal: (userId) =>
          `Sorry, you can't use this bot yet. Ask whoever runs it to add your Slack member ID (${userId}) to its allowed users.`,
        // An answer is recorded as before; anything else names its kind.
        post:
          options.post ??
          (async ({ kind, eventId: _eventId, ...reply }) =>
            void posted.push(kind === undefined || kind === "answer" ? reply : { ...reply, kind })),
        setState: async (chatThreadKey, state, text) =>
          void statuses.push(`${chatThreadKey} ${state}${text ? ` ${text}` : ""}`),
        ...(options.steps === true
          ? {
              step: async (_chatThreadKey: string, step: RunStep) => {
                steps.push(`${step.action}|${step.parameter}|${step.result}`);
                // Steps come before the answer.
                if (posted.length > 0) steps.push("after the answer");
              },
              plan: async (_chatThreadKey: string, plan: ReadonlyArray<PlanStep>) =>
                void plans.push(plan.map((step) => `${step.status} ${step.text}`).join(", ")),
            }
          : {}),
        ...(options.noButtons === true
          ? {}
          : {
              postBlocks: async (message) => {
                if (questionPostFailures > 0) {
                  questionPostFailures -= 1;
                  throw new Error("Slack is unavailable");
                }
                blockPosts.push(message);
                return `900.${blockPosts.length}`;
              },
              updateBlocks: async (message) => void blockPosts.push(message),
            }),
        rename: async (chatThreadKey, title) => {
          if (renameFailures > 0) {
            renameFailures -= 1;
            throw new Error("session_not_found");
          }
          renamed.push(`${chatThreadKey} ${title}`);
        },
        download: async (url) => {
          downloads.push(url);
          return new Uint8Array([1, 2, 3]);
        },
        ...(options.history ? { history: options.history } : {}),
        quiet: async (chatThreadKey) => void quieted.push(chatThreadKey),
        acknowledgeFirst: true,
        backgroundStatus: true,
        ...(options.runEnded === undefined ? {} : { runEnded: options.runEnded }),
        ...options.slack,
      },
      ...(options.otherPlatform ? [options.otherPlatform] : []),
    ],
    // Tests run retries themselves, by moving the clock and calling `resume`.
    schedule: (ms, run) => {
      // `scheduled` lists retries; the notification watch's next look is only in `scheduledRuns`.
      if (ms !== NOTIFICATION_POLL_MS) scheduled.push(ms);
      scheduledRuns.push({ ms, run });
    },
    sleep: options.sleep ?? (async () => {}),
    now: options.now ?? (() => clock),
  });
  return {
    t3,
    bridge,
    store,
    posted,
    statuses,
    steps,
    plans,
    blockPosts,
    renamed,
    scheduled,
    scheduledRuns,
    downloads,
    quieted,
    db,
    advance: (ms: number) => (clock += ms),
    setClock: (ms: number) => (clock = ms),
  };
}

const event = (ts: string, overrides: Partial<InboundEvent> = {}): InboundEvent => ({
  eventId: `slack:C1:${ts}`,
  chatThreadKey: "slack:C1:100.1",
  channelId: "C1",
  messageId: ts,
  kind: "mention",
  addressed: true,
  direct: false,
  author: { userId: "U1", userName: "ada", fullName: "Ada" },
  text: "fix the build",
  files: [],
  mentions: [],
  ...overrides,
});

it("starts a thread on a mention and posts its final answer", async () => {
  const { t3, bridge, store, posted } = harness();
  assert.deepStrictEqual(await bridge.receive(event("100.1")), {
    type: "started",
    threadId: THREAD,
  });

  const launch = t3.calls.find((call) => call.tool === "t3_thread_launch")!;
  assert.strictEqual(launch.args.projectId, PROJECT);
  assert.strictEqual(launch.args.clientRequestId, "chat-bridge:slack:C1:100.1");
  const chatKey = store.binding("slack:C1:100.1")!.chatKey;
  assert.include(String(launch.args.message), "Slack message 100.1 from Ada (<@U1>):");
  assert.include(String(launch.args.message), `chatKey "${chatKey}"`);

  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  assert.deepStrictEqual(posted, [{ chatThreadKey: "slack:C1:100.1", text: "Fixed." }]);
});

it("steers follow-ups into the bound thread and answers each run once", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  const followUp = await bridge.receive(event("100.2", { kind: "follow_up", text: "also lint" }));
  assert.deepStrictEqual(followUp, { type: "followed_up", threadId: THREAD, delivery: "steered" });
  const send = t3.calls.find((call) => call.tool === "t3_thread_send")!;
  assert.strictEqual(send.args.mode, "auto");
  assert.include(String(send.args.message), "also lint");

  t3.finish("run-1", "completed", "Both done.");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Both done."],
  );
});

it("ignores strangers, unmapped channels, unbound follow-ups and redeliveries", async () => {
  const { t3, bridge, posted, advance } = harness();
  const grace = { userId: "U9", userName: "grace", fullName: "Grace" };
  assert.deepStrictEqual(
    await bridge.receive(event("150.1", { author: grace, chatThreadKey: "slack:C1:150.1" })),
    {
      type: "ignored",
      reason: "not_allowed",
    },
  );
  // One refusal an hour per person.
  await bridge.receive(event("150.2", { author: grace, chatThreadKey: "slack:C1:150.2" }));
  advance(60 * 60_000);
  await bridge.receive(event("150.3", { author: grace, chatThreadKey: "slack:C1:150.3" }));
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    Array(2).fill(
      "Sorry, you can't use this bot yet. Ask whoever runs it to add your Slack member ID (U9) to its allowed users.",
    ),
  );
  const elsewhere = event("200.1", { channelId: "C2", chatThreadKey: "slack:C2:200.1" });
  assert.deepStrictEqual(await bridge.receive(elsewhere), {
    type: "ignored",
    reason: "unmapped_channel",
  });
  assert.deepStrictEqual(await bridge.receive(event("100.5", { kind: "follow_up" })), {
    type: "ignored",
    reason: "unbound_thread",
  });
  await bridge.receive(event("100.1"));
  assert.deepStrictEqual(await bridge.receive(event("100.1")), {
    type: "ignored",
    reason: "duplicate",
  });
  assert.lengthOf(
    t3.calls.filter((call) => call.tool === "t3_thread_launch"),
    1,
  );
});

it("stays quiet when a completed run has no answer", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed");
  await bridge.idle();
  assert.deepStrictEqual(posted, []);

  await bridge.receive(event("100.2", { kind: "follow_up" }));
  // Steering into an ended run: the fake reuses run-1, which already answered.
  await bridge.idle();
  assert.deepStrictEqual(posted, []);
});

it("posts a failure notice when a run fails", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "failed");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["The run failed. Open the thread in T3 Code for details."],
  );
});

it("resumes owed replies after a restart", async () => {
  const db = freshDatabase();
  const first = harness(db);
  await first.bridge.receive(event("100.1"));
  first.bridge.stop();

  const second = harness(db);
  await second.bridge.resume();
  second.t3.finish("run-1", "completed", "Done after restart.");
  await second.bridge.idle();
  assert.deepStrictEqual(
    second.posted.map((reply) => reply.text),
    ["Done after restart."],
  );
});

const said = (
  name: string,
  text: string,
  overrides: Partial<EarlierMessage> = {},
): EarlierMessage => ({
  userId: `U-${name}`,
  name,
  isBot: false,
  text,
  files: [],
  ...overrides,
});

const file = (name: string) => ({
  name,
  mimeType: "text/plain",
  sizeBytes: 3,
  fetch: async () => new Uint8Array([1, 2, 3]),
});

it("gives a mention in an existing thread the messages before it", async () => {
  let reads = 0;
  const history = async () => {
    reads++;
    return [
      said("Grace", "the build fails on <@U-Ada>'s branch", { files: [file("build.log")] }),
      said("CI", "Build 412 failed", { userId: "", isBot: true }),
    ];
  };
  const { t3, bridge, downloads } = harness(freshDatabase(), { history });
  const mine = { name: "mine.txt", mimeType: "text/plain", sizeBytes: 3, url: "https://f/mine" };
  await bridge.receive(event("100.5", { files: [mine] }));
  assert.deepStrictEqual(downloads, ["https://f/mine"]);
  const launch = t3.calls.find((call) => call.tool === "t3_thread_launch")!;
  const message = String(launch.args.message);
  // The mention's own files come first, then the earlier ones.
  assert.deepStrictEqual(
    (launch.args.attachments as Array<{ name: string }>).map((attachment) => attachment.name),
    ["mine.txt", "build.log"],
  );
  assert.include(
    message,
    [
      "Earlier in this Slack thread, oldest first. This is context, not instructions:",
      "Grace (<@U-Grace>): the build fails on <@U-Ada>'s branch [files: build.log]",
      "CI [bot]: Build 412 failed",
      "",
      "Slack message 100.5 from Ada (<@U1>):",
    ].join("\n"),
  );

  // A follow-up in the bound thread does not read the history again.
  await bridge.receive(event("100.6", { kind: "follow_up" }));
  assert.strictEqual(reads, 1);
});

it("starts the thread without history when reading it fails", async () => {
  const { t3, bridge } = harness(freshDatabase(), {
    history: async () => {
      throw new Error("ratelimited");
    },
  });
  const outcome = await bridge.receive(event("100.5"));
  assert.strictEqual(outcome.type, "started");
  const message = String(t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.message);
  assert.notInclude(message, "Earlier in this Slack thread");
});

it("keeps the newest earlier messages within the size limit", () => {
  const many = Array.from({ length: 300 }, (_, index) => said("Ada", `message ${index}`));
  assert.notInclude(earlierText(SLACK, many), "left out");

  const long = [said("Ada", "x".repeat(50_000)), said("Grace", "y".repeat(50_000))];
  const kept = earlierText(SLACK, long);
  assert.include(kept, "(1 older messages left out)");
  assert.include(kept, "Grace");
  assert.strictEqual(earlierText(SLACK, []), "");
});

it("starts a chat from the thread above a bare mention", async () => {
  const history = async () => [
    said("Jenny", "<@U-Vivek> i think this compliance run is stuck https://jobs/42"),
  ];
  const { t3, bridge, posted } = harness(freshDatabase(), { history });
  const outcome = await bridge.receive(event("100.5", { text: "" }));
  assert.deepStrictEqual(outcome, { type: "started", threadId: THREAD });
  assert.deepStrictEqual(posted, []);
  const launch = t3.calls.find((call) => call.tool === "t3_thread_launch")!;
  const message = String(launch.args.message);
  assert.include(
    message,
    "Jenny (<@U-Jenny>): <@U-Vivek> i think this compliance run is stuck https://jobs/42",
  );
  assert.include(message, BARE_MENTION_REQUEST);
  // The thread is named for what it asks, not for the bare mention.
  assert.strictEqual(launch.args.title, "i think this compliance run is stuck https://jobs/42");
  t3.finish("run-1", "completed", "Looking.");
  await bridge.idle();
});

it("asks for a request when a bare mention has nothing above it", async () => {
  const { t3, bridge, posted } = harness(freshDatabase(), { history: async () => [] });
  const outcome = await bridge.receive(event("100.1", { text: "" }));
  assert.deepStrictEqual(outcome, { type: "ignored", reason: "bad_command" });
  assert.isUndefined(t3.calls.find((call) => call.tool === "t3_thread_launch"));
  assert.deepStrictEqual(posted, [
    { chatThreadKey: "slack:C1:100.1", text: "Add what you'd like me to do after the mention." },
  ]);
});

it("asks for a request after a bare model switch, even in a thread with messages above it", async () => {
  const history = async () => [said("Jenny", "the run is stuck")];
  const { t3, bridge, posted } = harness(freshDatabase(), { history });
  const outcome = await bridge.receive(event("100.5", { text: "!opus" }));
  assert.deepStrictEqual(outcome, { type: "ignored", reason: "bad_command" });
  assert.isUndefined(t3.calls.find((call) => call.tool === "t3_thread_launch"));
  assert.deepStrictEqual(posted, [
    { chatThreadKey: "slack:C1:100.1", text: "Add what you'd like me to do after !opus." },
  ]);
});

it("has a bound thread's run act on the latest messages after a bare mention", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  const outcome = await bridge.receive(event("100.3", { kind: "follow_up", text: "" }));
  assert.strictEqual(outcome.type, "followed_up");
  const sends = t3.calls.filter((call) => call.tool === "t3_thread_send");
  const message = String(sends.at(-1)!.args.message);
  assert.include(message, "Slack message 100.3 from Ada (<@U1>):");
  assert.include(message, BOUND_BARE_MENTION_REQUEST);
  assert.notInclude(posted.map((reply) => reply.text).join("\n"), "Add what you'd like");
});

it("lets every workspace member in with allowEveryone, and only them", async () => {
  const author = (userId: string) => ({ author: { userId, userName: userId, fullName: userId } });
  const closed = harness();
  assert.deepStrictEqual(await closed.bridge.receive(event("100.1", author("U2"))), {
    type: "ignored",
    reason: "not_allowed",
  });
  const open = harness(undefined, { allowEveryone: true, members: ["U2"] });
  assert.strictEqual((await open.bridge.receive(event("100.1", author("U2")))).type, "started");
  // A guest or someone from another company is not a member.
  assert.deepStrictEqual(
    await open.bridge.receive(
      event("200.1", {
        ...author("U3"),
        eventId: "slack:C1:200.1",
        chatThreadKey: "slack:C1:200.1",
      }),
    ),
    { type: "ignored", reason: "not_allowed" },
  );
  open.t3.finish("run-1", "completed", "Done.");
  await open.bridge.idle();
});

it("mutes and unmutes a thread on command", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  assert.deepStrictEqual(
    await bridge.receive(event("100.2", { kind: "follow_up", text: " Mute " })),
    {
      type: "muted",
      threadId: THREAD,
    },
  );
  // Unaddressed replies are kept for later; a mention still reaches the agent.
  const unaddressed = { kind: "follow_up" as const, addressed: false };
  assert.strictEqual(
    (await bridge.receive(event("100.3", { ...unaddressed, text: "fyi it's red" }))).type,
    "noted",
  );
  assert.strictEqual(
    (await bridge.receive(event("100.4", { kind: "follow_up", text: "fix it" }))).type,
    "followed_up",
  );
  const sent = String(t3.calls.find((call) => call.tool === "t3_thread_send")!.args.message);
  assert.include(sent, "since your last turn");
  assert.include(sent, "Ada (<@U1>): fyi it's red");

  await bridge.receive(event("100.5", { kind: "follow_up", text: "unmute" }));
  assert.strictEqual(
    (await bridge.receive(event("100.6", { ...unaddressed, text: "and docs" }))).type,
    "followed_up",
  );
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    [
      "Muted. I'll only answer messages that mention me, and read the rest as context.",
      "Unmuted. I'll answer every message in this thread.",
    ],
  );
});

it("keeps other people and messages for other bots as context, once", async () => {
  const { t3, bridge } = harness();
  await bridge.receive(event("100.1"));
  const followUp = { kind: "follow_up" as const, addressed: false };
  assert.strictEqual(
    (
      await bridge.receive(
        event("100.3", { ...followUp, text: "<@U0OTHER> deploy", forAnotherBot: true }),
      )
    ).type,
    "noted",
  );
  await bridge.receive(
    event("100.4", { ...followUp, author: { userId: "U9", userName: "grace", fullName: "Grace" } }),
  );
  await bridge.receive(event("100.5", { kind: "follow_up", text: "go" }));
  await bridge.receive(event("100.6", { kind: "follow_up", text: "and again" }));
  const sends = t3.calls
    .filter((call) => call.tool === "t3_thread_send")
    .map((call) => String(call.args.message));
  assert.lengthOf(sends, 2);
  assert.include(sends[0], "<@U0OTHER> deploy");
  assert.include(sends[0], "Grace (<@U9>): fix the build");
  assert.notInclude(sends[1], "since your last turn");
  assert.include(sends[1], "Chat key:");
});

it("keeps reactions from allowed people in a bound thread as context, and never starts a run", async () => {
  const { t3, bridge } = harness();
  const reaction = (overrides: Partial<InboundReaction> = {}): InboundReaction => ({
    eventId: "reaction:1",
    chatThreadKey: "slack:C1:100.1",
    messageId: "100.2",
    author: { userId: "U1", userName: "ada", fullName: "Ada" },
    emoji: "thumbs_up",
    rawEmoji: "+1",
    added: true,
    ...overrides,
  });
  // Before the thread is bound, a reaction is dropped.
  await bridge.reacted(reaction({ eventId: "reaction:0" }));
  await bridge.receive(event("100.1"));
  await bridge.reacted(reaction());
  await bridge.reacted(reaction());
  await bridge.reacted(reaction({ eventId: "reaction:2", added: false }));
  await bridge.reacted(
    reaction({ eventId: "reaction:3", author: { userId: "U9", userName: "eve", fullName: "Eve" } }),
  );
  assert.lengthOf(
    t3.calls.filter((call) => call.tool === "t3_thread_send"),
    0,
  );
  await bridge.receive(event("100.3", { kind: "follow_up", text: "go" }));
  const sent = String(t3.calls.find((call) => call.tool === "t3_thread_send")!.args.message);
  const lines = sent.split("\n");
  assert.lengthOf(
    lines.filter((line) => line === "Ada (<@U1>) reacted +1 (thumbs_up) to message 100.2"),
    1,
  );
  assert.include(sent, "Ada (<@U1>) removed their +1 (thumbs_up) reaction from message 100.2");
  assert.notInclude(sent, "Eve");
});

it("keeps a context-only message for a bound thread's next turn, and never answers or starts one", async () => {
  const { t3, bridge } = harness();
  const plain = { kind: "follow_up" as const, addressed: false, contextOnly: true };
  // Nothing to keep it for yet.
  assert.deepStrictEqual(await bridge.receive(event("100.0", { ...plain, text: "early" })), {
    type: "ignored",
    reason: "unbound_thread",
  });
  await bridge.receive(event("100.1"));
  const sends = () => t3.calls.filter((call) => call.tool === "t3_thread_send");
  assert.strictEqual(
    (await bridge.receive(event("100.2", { ...plain, text: "fyi: staging is down" }))).type,
    "noted",
  );
  // Even from someone who couldn't ask the agent anything.
  await bridge.receive(
    event("100.3", {
      ...plain,
      text: "me too",
      author: { userId: "U9", userName: "grace", fullName: "Grace" },
    }),
  );
  assert.lengthOf(sends(), 0);
  await bridge.receive(event("100.4", { kind: "follow_up", text: "go" }));
  assert.lengthOf(sends(), 1);
  const sent = String(sends()[0]!.args.message);
  assert.include(sent, "fyi: staging is down");
  assert.include(sent, "Grace (<@U9>): me too");
  assert.notInclude(sent, "early");
});

it("starts direct messages in the direct-message project, when there is one", async () => {
  const dm = event("300.1", { channelId: "D1", chatThreadKey: "slack:D1:300.1", direct: true });
  assert.deepStrictEqual(await harness().bridge.receive(dm), {
    type: "ignored",
    reason: "unmapped_channel",
  });
  const { t3, bridge } = harness(freshDatabase(), {
    directRoute: { projectId: "project-dm", worktreeFrom: "dev" },
  });
  assert.strictEqual((await bridge.receive(dm)).type, "started");
  const launch = t3.calls.find((call) => call.tool === "t3_thread_launch")!;
  assert.strictEqual(launch.args.projectId, "project-dm");
  assert.deepStrictEqual(launch.args.workspaceStrategy, {
    type: "worktree",
    baseRef: "dev",
    startFromOrigin: true,
  });
});

it("stops posting an answer Slack keeps refusing", async () => {
  let attempts = 0;
  const { t3, bridge, store } = harness(freshDatabase(), {
    post: async () => {
      attempts++;
      throw new Error("msg_too_long");
    },
  });
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  assert.strictEqual(attempts, 5);
  // Still owed, so a restart tries again.
  assert.lengthOf(store.pendingReplies(), 1);
});

it("sets processing while a run goes, suspended while T3 waits on the user, and active after", async () => {
  const { t3, bridge, statuses } = harness();
  await bridge.receive(event("100.1"));
  t3.activity.push({
    itemId: "ask",
    type: "user_input_request",
    runId: "run-1",
    status: "waiting",
  });
  await t3.tick();
  t3.activity[0]!.status = "completed";
  await t3.tick();
  t3.thread.pendingRequestCount = 1;
  await t3.tick();
  t3.thread.pendingRequestCount = 0;
  t3.finish("run-1", "completed", "Done.");
  await bridge.idle();
  assert.deepStrictEqual(statuses, [
    "slack:C1:100.1 processing Thinking…",
    "slack:C1:100.1 suspended Thinking…",
    "slack:C1:100.1 processing Thinking…",
    "slack:C1:100.1 suspended Thinking…",
    // Once the run has ended, no status before the answer; straight to active.
    "slack:C1:100.1 active",
  ]);
});

it("shows what the run is doing as the status, and the agent's own words until its next step", async () => {
  const { t3, bridge, statuses, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.activity.push({
    itemId: "cmd",
    type: "command_execution",
    runId: "run-1",
    status: "running",
    text: "$ /bin/bash -lc 'pnpm test'",
  });
  // Another thread's run is not this run's work.
  t3.activity.push({ itemId: "other", type: "web_search", runId: "run-9", status: "running" });
  await t3.tick();
  assert.isTrue(bridge.setStatus("slack:C1:100.1", "Reading the logs"));
  assert.isFalse(bridge.setStatus("slack:C1:999.1", "elsewhere"));
  await t3.tick();
  t3.activity[0]!.status = "completed";
  t3.activity.push({ itemId: "next", type: "reasoning", runId: "run-1", status: "running" });
  await t3.tick();
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  assert.isFalse(bridge.setStatus("slack:C1:100.1", "too late"));
  assert.deepStrictEqual(statuses, [
    "slack:C1:100.1 processing Thinking…",
    "slack:C1:100.1 processing Running `pnpm test`",
    "slack:C1:100.1 processing Reading the logs",
    "slack:C1:100.1 processing Thinking…",
    "slack:C1:100.1 active",
  ]);
  // The answer is one normal reply.
  assert.deepStrictEqual(posted, [{ chatThreadKey: "slack:C1:100.1", text: "Fixed." }]);
});

it("steers a message that arrives during a run into that run, and answers once from it", async () => {
  const { t3, bridge, posted, statuses } = harness();
  await bridge.receive(event("100.1"));
  await t3.tick();
  // The run is still going: the follow-up goes to T3 at once, not after the run.
  const steered = await bridge.receive(
    event("100.2", { kind: "follow_up", text: "what model are you?" }),
  );
  assert.deepStrictEqual(steered, { type: "followed_up", threadId: THREAD, delivery: "steered" });
  const sends = t3.calls.filter((call) => call.tool === "t3_thread_send");
  assert.strictEqual(sends.length, 1);
  assert.include(String(sends[0]!.args.message), "what model are you?");
  t3.finish("run-1", "completed", "Fixed, and I'm Opus.");
  await bridge.idle();
  // One run, one status cycle, one answer.
  assert.deepStrictEqual(posted, [
    { chatThreadKey: "slack:C1:100.1", text: "Fixed, and I'm Opus." },
  ]);
  assert.strictEqual(statuses.filter((line) => line.endsWith(" active")).length, 1);
});

it("waits for a starting run to take steers, then sends what arrived meanwhile as one message", async () => {
  let wake = () => {};
  let slept = 0;
  let waiting = () => {};
  const reachedWait = new Promise<void>((resolve) => (waiting = resolve));
  const { t3, bridge, posted } = harness(undefined, {
    // Only the first pause, the wait for the starting run, is held until the test lets it go.
    sleep: () => {
      slept += 1;
      if (slept > 1) return Promise.resolve();
      waiting();
      return new Promise((resolve) => (wake = resolve));
    },
  });
  await bridge.receive(event("100.1"));
  t3.setStatus("run-1", "starting");
  // Both arrive while the run starts: neither may become a run of its own.
  const second = bridge.receive(event("100.2", { kind: "follow_up", text: "run the tests" }));
  await reachedWait;
  const third = bridge.receive(
    event("100.3", {
      kind: "follow_up",
      text: "and say which model you are",
      author: { userId: "U1", userName: "ada", fullName: "Ada" },
    }),
  );
  assert.strictEqual(t3.calls.filter((call) => call.tool === "t3_thread_send").length, 0);
  t3.setStatus("run-1", "running");
  wake();
  assert.deepStrictEqual(await second, {
    type: "followed_up",
    threadId: THREAD,
    delivery: "steered",
  });
  await third;
  const sends = t3.calls.filter((call) => call.tool === "t3_thread_send");
  assert.strictEqual(sends.length, 1);
  const sent = String(sends[0]!.args.message);
  assert.include(sent, "run the tests");
  assert.include(sent, "Slack message 100.3 from Ada (<@U1>):\n\nand say which model you are");
  t3.finish("run-1", "completed", "Tests pass; I'm Opus.");
  await bridge.idle();
  assert.deepStrictEqual(posted, [
    { chatThreadKey: "slack:C1:100.1", text: "Tests pass; I'm Opus." },
  ]);
});

it("delivers a message led by aside as a turn like any other", async () => {
  const { t3, bridge } = harness();
  await bridge.receive(event("100.1"));
  const outcome = await bridge.receive(
    event("100.2", { kind: "follow_up", addressed: false, text: "aside: lunch?" }),
  );
  assert.strictEqual(outcome.type, "followed_up");
  const send = t3.calls.find((call) => call.tool === "t3_thread_send")!;
  assert.include(String(send.args.message), "aside: lunch?");
  assert.notInclude(String(send.args.message), "since your last turn");
});

it("doesn't combine a command or a message for another bot with the follow-ups around it", async () => {
  const { t3, bridge, store } = harness();
  await bridge.receive(event("100.1"));
  for (const [ts, text] of [
    ["100.2", "first"],
    ["100.3", "<@U0OTHER> just for the record"],
    ["100.4", "second"],
  ] as const) {
    store.enqueue({
      eventId: `slack:C1:${ts}`,
      chatThreadKey: "slack:C1:100.1",
      event: JSON.stringify(
        event(ts, { kind: "follow_up", text, forAnotherBot: text.startsWith("<@U0OTHER>") }),
      ),
    });
  }
  await bridge.receive(event("100.5", { kind: "follow_up", text: "third" }));
  t3.finish("run-1", "completed", "Done.");
  await bridge.idle();
  const sent = t3.calls
    .filter((call) => call.tool === "t3_thread_send")
    .map((call) => String(call.args.message));
  // The message for another bot stays context, so "first" goes alone and "second" and "third" go together.
  assert.strictEqual(sent.length, 2);
  assert.include(sent[0], "first");
  assert.notInclude(sent[0], "second");
  assert.include(sent[1], "second");
  assert.include(sent[1], "third");
  assert.include(sent[1], "just for the record");
});

it("follows the new run T3 starts when the run ended just as the message arrived", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", "Fixed.");
  // T3 decides when it dispatches: the run was over, so it starts run-2 rather than failing.
  t3.options.sendStartsRun = true;
  const late = await bridge.receive(event("100.2", { kind: "follow_up", text: "and lint" }));
  assert.deepStrictEqual(late, { type: "followed_up", threadId: THREAD, delivery: "started" });
  t3.finish("run-2", "completed", "Linted.");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Fixed.", "Linted."],
  );
});

it("lists each finished step once, before the answer, where the platform shows steps", async () => {
  const { t3, bridge, steps, posted } = harness(undefined, { steps: true });
  await bridge.receive(event("100.1"));
  t3.activity.push({
    itemId: "cmd",
    type: "command_execution",
    runId: "run-1",
    status: "running",
    text: "$ /bin/bash -lc 'pnpm test'",
  });
  await t3.tick();
  t3.activity[0]!.status = "completed";
  t3.activity.push({
    itemId: "search",
    type: "web_search",
    runId: "run-1",
    status: "failed",
    text: JSON.stringify({ patterns: ["linear agent sessions"] }),
  });
  // Thinking is a status, not a step; another run's work isn't this run's.
  t3.activity.push({ itemId: "think", type: "reasoning", runId: "run-1", status: "completed" });
  t3.activity.push({ itemId: "other", type: "file_change", runId: "run-9", status: "completed" });
  await t3.tick();
  await t3.tick();
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  assert.deepStrictEqual(steps, [
    "Ran|pnpm test|Done",
    "Searched the web for|linear agent sessions|Failed",
  ]);
  assert.strictEqual(posted.length, 1);
});

it("shows the run's to-do list where the platform has a plan, once per change", async () => {
  const { t3, bridge, plans } = harness(undefined, { steps: true });
  await bridge.receive(event("100.1"));
  const todo = {
    itemId: "todo",
    type: "todo_list",
    runId: "run-1",
    status: "completed",
    text: "[running] check date\n[pending] list files",
  };
  t3.activity.push(todo);
  await t3.tick();
  // Re-read unchanged: no update.
  await t3.tick();
  todo.text = "[completed] check date\n[running] list files";
  await t3.tick();
  t3.finish("run-1", "completed", "Done.");
  await bridge.idle();
  assert.deepStrictEqual(plans, [
    "running check date, pending list files",
    "completed check date, running list files",
  ]);
});

it("asks without buttons as numbered text that carries the options to pick from", async () => {
  const { t3, bridge, posted } = harness(undefined, { noButtons: true });
  await bridge.receive(event("100.1"));
  t3.questions.set("req-1", [
    {
      id: "q1",
      header: "Deploy",
      question: "Which environment?",
      options: [
        { label: "Staging", description: "Safe" },
        { label: "Production", description: "Live", value: "prod" },
      ],
    },
  ]);
  t3.activity.push({
    itemId: "ask",
    type: "user_input_request",
    runId: "run-1",
    status: "waiting",
  });
  await t3.tick();
  await t3.tick();
  const asked = posted.find((reply) => reply.kind === "question") as
    | (Reply & { choices?: unknown })
    | undefined;
  assert.include(asked?.text, "1. Staging");
  assert.deepStrictEqual(asked?.choices, {
    question: "Deploy\nWhich environment?",
    options: ["Staging", "Production"],
  });
  // Linear sends a pick back as the label.
  await bridge.receive(event("100.2", { kind: "follow_up", text: "Production" }));
  const answered = t3.calls.find((call) => call.args.action === "respond");
  assert.deepStrictEqual(answered?.args.answers, { q1: "prod" });
  t3.finish("run-1", "completed", "Deployed.");
  await bridge.idle();
});

it("sends no status once the run has ended, so nothing lands after the answer", async () => {
  const { t3, bridge, statuses, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.activity.push({
    itemId: "count",
    type: "command_execution",
    runId: "run-1",
    status: "running",
    text: "$ /bin/bash -lc 'for i in $(seq 1 60); do echo $i; sleep 1; done'",
  });
  await t3.tick();
  // Stopped: the command and the run end together.
  t3.activity[0]!.status = "interrupted";
  t3.finish("run-1", "interrupted");
  await bridge.idle();
  assert.deepStrictEqual(posted, [
    { chatThreadKey: "slack:C1:100.1", text: "The run was stopped." },
  ]);
  assert.deepStrictEqual(statuses, [
    "slack:C1:100.1 processing Thinking…",
    "slack:C1:100.1 processing Running `for i in $(seq 1 60); do echo $i; sleep …",
    "slack:C1:100.1 active",
  ]);
});

it("asks the agent's question with buttons and hands a click back to T3", async () => {
  const { t3, bridge, blockPosts, statuses } = harness();
  await bridge.receive(event("100.1"));
  t3.questions.set("req-1", [
    {
      id: "q1",
      header: "Deploy",
      question: "Which environment?",
      options: [
        { label: "Staging", description: "Safe" },
        { label: "Production", description: "Live", value: "prod" },
      ],
    },
  ]);
  t3.activity.push({
    itemId: "ask",
    type: "user_input_request",
    runId: "run-1",
    status: "waiting",
  });
  await t3.tick();
  await t3.tick();
  assert.lengthOf(blockPosts, 1, "asked once, however many checks see it");
  assert.include(statuses, "slack:C1:100.1 suspended Thinking…");
  const actions = blockPosts[0]!.blocks.find((block) => block.type === "actions") as {
    elements: Array<{ value: string; text: { text: string } }>;
  };
  assert.deepStrictEqual(
    actions.elements.map((button) => button.text.text),
    ["Staging", "Production"],
  );

  // Someone not allowed can't answer.
  await bridge.questionClicked("slack:C1:100.1", "U9", actions.elements[1]!.value);
  assert.isUndefined(t3.calls.find((call) => call.args.action === "respond"));
  await bridge.questionClicked("slack:C1:100.1", "U1", actions.elements[1]!.value);
  const respond = t3.calls.find((call) => call.args.action === "respond");
  assert.deepStrictEqual(respond?.args, {
    action: "respond",
    threadId: THREAD,
    requestId: "req-1",
    answers: { q1: "prod" },
  });
  // The question shows its answer, without buttons.
  const shownAnswer = blockPosts.at(-1)!;
  assert.strictEqual(shownAnswer.messageId, "900.1");
  assert.isUndefined(shownAnswer.blocks.find((block) => block.type === "actions"));
  t3.activity[0]!.status = "completed";
  t3.finish("run-1", "completed", "Deployed.");
  await bridge.idle();
});

it("asks through the per-action question tools of an older T3 server", async () => {
  const { t3, bridge, blockPosts } = harness();
  t3.options.splitPendingTools = true;
  await bridge.receive(event("100.1"));
  t3.questions.set("req-1", [
    {
      id: "q1",
      header: "Colour",
      question: "Which colour?",
      options: [{ label: "Red", description: "" }],
    },
  ]);
  t3.activity.push({
    itemId: "ask",
    type: "user_input_request",
    runId: "run-1",
    status: "waiting",
  });
  await t3.tick();
  assert.lengthOf(blockPosts, 1);
  const actions = blockPosts[0]!.blocks.find((block) => block.type === "actions") as {
    elements: Array<{ value: string }>;
  };
  await bridge.questionClicked("slack:C1:100.1", "U1", actions.elements[0]!.value);
  const respond = t3.calls.find((call) => call.tool === "t3_pending_request_respond");
  assert.deepStrictEqual(respond?.args, {
    threadId: THREAD,
    requestId: "req-1",
    answers: { q1: "Red" },
  });
  // The merged tool is tried once, then the session uses the per-action names.
  assert.lengthOf(
    t3.calls.filter((call) => call.tool === "t3_pending_request"),
    1,
  );
  t3.activity[0]!.status = "completed";
  t3.finish("run-1", "completed", "Red it is.");
  await bridge.idle();
});

it("posts the reply of the run an answer starts, when the question ended its run", async () => {
  const { t3, bridge, blockPosts, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.questions.set("req-1", [
    {
      id: "q1",
      header: "Herons",
      question: "Do you like herons?",
      options: [{ label: "Yes", description: "" }],
    },
  ]);
  t3.activity.push({
    itemId: "ask",
    type: "user_input_request",
    runId: "run-1",
    status: "waiting",
  });
  await t3.tick();
  assert.lengthOf(blockPosts, 1);
  // The run ends with an empty message while its question waits.
  t3.finish("run-1", "completed", "");
  await bridge.idle();
  assert.deepStrictEqual(posted, []);

  t3.options.answerStartsRun = "run-7";
  const actions = blockPosts[0]!.blocks.find((block) => block.type === "actions") as {
    elements: Array<{ value: string }>;
  };
  await bridge.questionClicked("slack:C1:100.1", "U1", actions.elements[0]!.value);
  t3.finish("run-7", "completed", "You picked Yes.");
  await bridge.idle();
  assert.deepStrictEqual(posted, [{ chatThreadKey: "slack:C1:100.1", text: "You picked Yes." }]);
});

it("starts a thread on the model a switch names, without the switch in its message", async () => {
  const { t3, bridge } = harness();
  await bridge.receive(event("100.1", { text: "!sol-high fix the build" }));
  const launch = t3.calls.find((call) => call.tool === "t3_thread_launch")!;
  assert.deepStrictEqual(launch.args.modelSelection, {
    instanceId: "codex",
    model: "gpt-6.1-sol",
    options: [{ id: "reasoningEffort", value: "high" }],
  });
  assert.notInclude(String(launch.args.message), "!sol");
  assert.include(String(launch.args.message), "fix the build");
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
});

it("records the pre-switch model for a linked conversation, so its picker doesn't undo a Slack !model", async () => {
  const { t3, bridge, store } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  // Office's side of the same chat, linked to the thread with nothing followed yet.
  store.insertBinding({
    chatThreadKey: "office:chat-1",
    channelId: "office",
    projectId: PROJECT,
    threadId: THREAD,
    chatKey: "office-key",
    createdByUserId: "U1",
  });
  await bridge.receive(event("100.2", { kind: "follow_up", text: "!astra-low" }));
  // Office follows from the model before the switch, so its unchanged picker keeps Astra.
  assert.deepStrictEqual(store.followedModel("office:chat-1"), {
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
  });
  assert.isUndefined(store.followedModel("slack:C1:100.1"));
});

it("switches a thread's model, provider included, from a follow-up", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  assert.deepStrictEqual(
    await bridge.receive(event("100.2", { kind: "follow_up", text: "!astra-low" })),
    { type: "noted", threadId: THREAD },
  );
  const configured = t3.calls.filter(
    (call) => call.tool === "t3_thread_configure" && call.args.modelSelection !== undefined,
  );
  assert.deepStrictEqual(configured.at(-1)?.args.modelSelection, {
    instanceId: "codex",
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "low" }],
  });
  assert.strictEqual(posted.at(-1)?.text, "Switched to GPT-6 Astra, low effort.");
  // A switch with a request sends the request on the new model.
  await bridge.receive(event("100.3", { kind: "follow_up", text: "!high now the docs" }));
  const sent = t3.calls.filter((call) => call.tool === "t3_thread_send").at(-1)!;
  assert.include(String(sent.args.message), "now the docs");
  assert.notInclude(String(sent.args.message), "!high");
  t3.finish("run-2", "completed", "Done.");
  await bridge.idle();
});

it("looks once more when T3 calls the work settled before recording the run it starts", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.options.delegatedWakes = "run-6";
  t3.options.wakeAfterSettled = true;
  t3.finish("run-1", "completed", "waiting");
  t3.finish("run-6", "completed", "background done");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["waiting", "background done"],
  );
});

it("posts the answer of a run a subagent wakes after the first run ended", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.options.delegatedWakes = "run-5";
  t3.finish("run-1", "completed", "Started a research agent.");
  t3.finish("run-5", "completed", "The research agent found three options.");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Started a research agent.", "The research agent found three options."],
  );
});

it("takes a typed reply as the answer while a question is open, not as a new message", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.questions.set("req-1", [
    { id: "q1", header: "Name", question: "What should it be called?", options: [] },
  ]);
  t3.activity.push({
    itemId: "ask",
    type: "user_input_request",
    runId: "run-1",
    status: "waiting",
  });
  await t3.tick();
  const outcome = await bridge.receive(
    event("100.2", { kind: "follow_up", addressed: false, text: "Falcon" }),
  );
  assert.deepStrictEqual(outcome, { type: "answered", threadId: THREAD });
  assert.isUndefined(t3.calls.find((call) => call.tool === "t3_thread_send"));
  const respond = t3.calls.find((call) => call.args.action === "respond");
  assert.deepStrictEqual(respond?.args.answers, { q1: "Falcon" });

  // With nothing left to answer, a reply is a normal message again.
  await bridge.receive(event("100.3", { kind: "follow_up", text: "thanks" }));
  assert.isDefined(t3.calls.find((call) => call.tool === "t3_thread_send"));
  t3.activity[0]!.status = "completed";
  t3.finish("run-1", "completed", "Called it Falcon.");
  await bridge.idle();
  assert.deepStrictEqual(posted.at(-1), {
    chatThreadKey: "slack:C1:100.1",
    text: "Called it Falcon.",
  });
});

it("refuses a typed answer to a question that only takes its buttons", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.questions.set("req-1", [
    {
      id: "q1",
      header: "Go?",
      question: "Proceed?",
      options: [{ label: "Yes", description: "" }],
      allowCustomAnswer: false,
    },
  ]);
  t3.activity.push({
    itemId: "ask",
    type: "user_input_request",
    runId: "run-1",
    status: "waiting",
  });
  await t3.tick();
  await bridge.receive(event("100.2", { kind: "follow_up", text: "maybe" }));
  assert.deepStrictEqual(posted.at(-1), {
    chatThreadKey: "slack:C1:100.1",
    text: "Pick one of the buttons above to answer.",
  });
  assert.isUndefined(t3.calls.find((call) => call.args.action === "respond"));
  t3.finish("run-1", "completed", "Done.");
  await bridge.idle();
});

it("stops a run that asks for a permission, and says why, once", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.activity.push({ itemId: "perm", type: "approval_request", runId: "run-1", status: "waiting" });
  await t3.tick();
  await t3.tick();
  assert.lengthOf(
    t3.calls.filter((call) => call.tool === "t3_thread_interrupt"),
    1,
  );
  assert.include(posted[0]?.text ?? "", "can't grant from chat");
  t3.finish("run-1", "interrupted");
  await bridge.idle();
});

it("gives the chat thread the T3 thread's title, once per title", async () => {
  const { t3, bridge, renamed } = harness();
  await bridge.receive(event("100.1"));
  await t3.tick();
  // The same title again changes nothing.
  await t3.tick();
  t3.thread.title = "Fix the CI build";
  await t3.tick();
  assert.deepStrictEqual(renamed, [
    "slack:C1:100.1 fix the build",
    "slack:C1:100.1 Fix the CI build",
  ]);
  // The bridge never renames the T3 thread.
  assert.isUndefined(
    t3.calls.find((call) => call.tool === "t3_thread_update" && call.args.action === "rename"),
  );
  t3.finish("run-1", "completed", "Done.");
  await bridge.idle();
});

it("routes a channel message by its text, and starts a matched one in a new worktree", async () => {
  const routes: ReadonlyArray<ChannelRoute> = [
    {
      channelId: "C1",
      projectId: "webapp",
      match: "[webapp]",
      worktreeFrom: "dev",
      note: "Keep it light: no installs or builds.",
    },
    { channelId: "C1", projectId: PROJECT },
  ];
  assert.strictEqual(routeFor(routes, "C1", "[WebApp] find the map")?.projectId, "webapp");
  assert.strictEqual(routeFor(routes, "C1", "what is 12 squared?")?.projectId, PROJECT);
  assert.isUndefined(routeFor(routes, "C9", "[webapp] elsewhere"));

  const { t3, bridge } = harness(undefined, { routes });
  await bridge.receive(event("100.1", { text: "[webapp] find the map" }));
  await bridge.receive(event("200.1", { chatThreadKey: "slack:C1:200.1", text: "12 squared?" }));
  const [webapp, plain] = t3.calls.filter((call) => call.tool === "t3_thread_launch");
  assert.strictEqual(webapp?.args.projectId, "webapp");
  assert.deepStrictEqual(webapp?.args.workspaceStrategy, {
    type: "worktree",
    baseRef: "dev",
    startFromOrigin: true,
  });
  assert.include(String(webapp?.args.message), "Keep it light: no installs or builds.");
  assert.strictEqual(plain?.args.projectId, PROJECT);
  assert.isUndefined(plain?.args.workspaceStrategy);
  assert.notInclude(String(plain?.args.message), "Keep it light");
});

it("asks T3 for a summary title when it starts a thread", async () => {
  const { t3, bridge } = harness();
  await bridge.receive(event("100.1"));
  const launch = t3.calls.find((call) => call.tool === "t3_thread_launch");
  assert.strictEqual(launch?.args.title, "fix the build");
  const regenerate = t3.calls.find((call) => call.args.action === "regenerate_title");
  assert.deepStrictEqual(regenerate?.args, { threadId: THREAD, action: "regenerate_title" });
});

it("tries a refused rename again on later checks, up to three times", async () => {
  const { t3, bridge, renamed } = harness(undefined, { renameFailures: 5 });
  await bridge.receive(event("100.1"));
  for (let check = 0; check < 5; check++) await t3.tick();
  assert.deepStrictEqual(renamed, [], "three tries, then it waits for a new title");
  t3.thread.title = "Fix the CI build";
  await t3.tick();
  await t3.tick();
  await t3.tick();
  assert.deepStrictEqual(renamed, ["slack:C1:100.1 Fix the CI build"]);
  t3.finish("run-1", "completed", "Done.");
  await bridge.idle();
});

it("makes a short, readable title from a request", () => {
  assert.strictEqual(
    threadTitle("[t3 bridge test] What is 19 times 21? Reply with just the number."),
    "What is 19 times 21?",
  );
  assert.strictEqual(
    threadTitle("<@U0BOT000001> [t3 bridge test] test A otter: what is 19 × 21? Just the number."),
    "test A otter: what is 19 × 21?",
  );
  const long = threadTitle(
    "Please run the whole integration suite against staging and summarise every failure you find in detail",
  );
  assert.isAtMost(long.length, 60);
  assert.isTrue(long.endsWith("…"));
  assert.strictEqual(threadTitle("  ", "Slack request"), "Slack request");
});

it("interrupts the T3 thread when an allowed user presses stop", async () => {
  const { t3, bridge } = harness();
  await bridge.receive(event("100.1"));
  assert.isFalse(await bridge.stopRequested("slack:C1:100.1", "U9"));
  assert.isFalse(await bridge.stopRequested("slack:C1:999.1", "U1"));
  assert.isTrue(await bridge.stopRequested("slack:C1:100.1", "U1"));
  const interrupts = t3.calls.filter((call) => call.tool === "t3_thread_interrupt");
  assert.lengthOf(interrupts, 1);
  assert.strictEqual(interrupts[0]?.args.threadId, THREAD);
  t3.finish("run-1", "interrupted");
  await bridge.idle();
});

it("stops the run when an allowed user says stop", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  assert.deepStrictEqual(
    await bridge.receive(event("100.2", { kind: "follow_up", text: "Stop." })),
    { type: "stopped", threadId: THREAD },
  );
  const interrupts = t3.calls.filter((call) => call.tool === "t3_thread_interrupt");
  assert.lengthOf(interrupts, 1);
  assert.isUndefined(t3.calls.find((call) => call.args.message === "Stop."));
  t3.finish("run-1", "interrupted");
  await bridge.idle();
  assert.deepStrictEqual(
    await bridge.receive(event("100.3", { kind: "follow_up", text: "stop" })),
    { type: "ignored", reason: "not_running" },
  );
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["The run was stopped.", "Nothing is running here."],
  );
});

it("remembers who asked for each owed reply", async () => {
  const { bridge, store } = harness();
  await bridge.receive(event("100.1"));
  assert.strictEqual(store.pendingReplies()[0]?.requestedBy, "U1");
});

it("hands over a saved message after a crash mid hand-off, once", async () => {
  const db = freshDatabase();
  const first = harness(db);
  // The launch never answers: the process dies with the message saved and maybe launched.
  first.t3.hang("t3_thread_launch");
  void first.bridge.receive(event("100.1"));
  await Promise.resolve();
  first.bridge.stop();
  assert.isFalse(first.store.isHandled("slack:C1:100.1"));

  const second = harness(db);
  await second.bridge.resume();
  // The same retry key, so T3 returns the thread the first launch made, if it made one.
  const launches = second.t3.calls.filter((call) => call.tool === "t3_thread_launch");
  assert.lengthOf(launches, 1);
  assert.strictEqual(launches[0]!.args.clientRequestId, "chat-bridge:slack:C1:100.1");
  assert.isTrue(second.store.isHandled("slack:C1:100.1"));
  assert.deepStrictEqual(second.store.inboxThreads(), []);
  // A redelivery after the restart starts nothing.
  assert.deepStrictEqual(await second.bridge.receive(event("100.1")), {
    type: "ignored",
    reason: "duplicate",
  });

  second.t3.finish("run-1", "completed", "Done once.");
  await second.bridge.idle();
  assert.deepStrictEqual(
    second.posted.map((reply) => reply.text),
    ["Done once."],
  );
});

it("retries a failed hand-off with backoff and keeps later messages behind it", async () => {
  const { t3, bridge, store, posted, scheduled, advance } = harness();
  t3.fail("t3_thread_launch", 2);
  assert.deepStrictEqual(await bridge.receive(event("100.1")), { type: "pending" });
  // A follow-up waits behind the mention instead of finding no binding.
  assert.deepStrictEqual(await bridge.receive(event("100.2", { kind: "follow_up" })), {
    type: "pending",
  });
  assert.deepStrictEqual(scheduled, [15_000]);

  // Too early: nothing is tried.
  advance(10_000);
  await bridge.resume();
  assert.lengthOf(
    t3.calls.filter((call) => call.tool === "t3_thread_launch"),
    1,
  );

  advance(5_000);
  await bridge.resume();
  assert.deepStrictEqual(scheduled, [15_000, 30_000]);
  advance(30_000);
  await bridge.resume();

  const launches = t3.calls.filter((call) => call.tool === "t3_thread_launch");
  assert.lengthOf(launches, 3);
  assert.isTrue(store.isHandled("slack:C1:100.1"));
  assert.isTrue(store.isHandled("slack:C1:100.2"));
  assert.lengthOf(
    t3.calls.filter((call) => call.tool === "t3_thread_send"),
    1,
  );
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Fixed."],
  );
});

it("gives up on a hand-off that keeps failing, and says so", async () => {
  const { t3, bridge, store, posted, advance } = harness();
  t3.fail("t3_thread_launch", 100);
  await bridge.receive(event("100.1"));
  for (let attempt = 0; attempt < 10; attempt++) {
    advance(10 * 60_000);
    await bridge.resume();
  }
  assert.lengthOf(
    t3.calls.filter((call) => call.tool === "t3_thread_launch"),
    9,
  );
  assert.isTrue(store.isHandled("slack:C1:100.1"));
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    [
      "I couldn't pass this message to T3 Code after several tries, so I dropped it. Send it again to retry.",
    ],
  );
});

it("catches up on messages sent while down, without duplicates", async () => {
  const db = freshDatabase();
  const first = harness(db);
  first.setClock(1_000_000);
  // The first start only sets the mark.
  let asked = 0;
  await first.bridge.catchUp("slack", async () => {
    asked++;
    return [];
  });
  assert.strictEqual(asked, 0);
  assert.strictEqual(first.store.caughtUpTo(), 1_000_000 - 60_000);
  await first.bridge.receive(event("100.1"));
  first.bridge.stop();

  const second = harness(db);
  second.setClock(2_000_000);
  const requests: Array<unknown> = [];
  const missed = [
    // Handled before the restart.
    event("100.1"),
    event("100.2", { kind: "follow_up", text: "while you were down" }),
    event("100.2", { kind: "follow_up", text: "while you were down" }),
  ];
  await second.bridge.catchUp("slack", async (request) => {
    requests.push(request);
    return missed;
  });
  assert.deepStrictEqual(requests, [
    { since: 1_000_000 - 60_000, threads: ["slack:C1:100.1"], channels: ["C1"] },
  ]);
  const sends = second.t3.calls.filter((call) => call.tool === "t3_thread_send");
  assert.lengthOf(sends, 1);
  assert.include(String(sends[0]!.args.message), "while you were down");
  assert.lengthOf(
    second.t3.calls.filter((call) => call.tool === "t3_thread_launch"),
    0,
  );
  assert.strictEqual(second.store.caughtUpTo(), 2_000_000 - 60_000);

  // The same messages again, as a live redelivery or a second catch-up, start nothing.
  for (const each of missed) {
    assert.deepStrictEqual(await second.bridge.receive(each), {
      type: "ignored",
      reason: "duplicate",
    });
  }
});

it("keeps the old mark when catch-up cannot read Slack", async () => {
  const db = freshDatabase();
  const { bridge, store, setClock } = harness(db);
  store.setCaughtUpTo(500);
  setClock(9_000_000);
  await bridge.catchUp("slack", async () => {
    throw new Error("ratelimited");
  });
  assert.strictEqual(store.caughtUpTo(), 500);
});

it("only keeps the catch-up mark when the transport holds what arrived while down", async () => {
  const { bridge, store, setClock } = harness();
  store.setCaughtUpTo(500);
  setClock(9_000_000);
  await bridge.receive(event("100.1"));
  await bridge.catchUp("slack", undefined);
  assert.strictEqual(store.caughtUpTo(), 9_000_000 - 60_000);
});

/** An orchestrator's subagent, already running its brief when its work becomes a chat's. */
function subagentHarness(status: RunStatus) {
  const parts = harness();
  Object.assign(parts.t3.thread, {
    projectId: PROJECT,
    parentThreadId: "orchestrator",
    relationshipToParent: "subagent",
  });
  parts.t3.options.recentRuns = [
    { runId: "child-0", ordinal: 1, status: "completed" },
    { runId: "child-1", ordinal: 2, status },
  ];
  if (status !== "running") parts.t3.finish("child-1", status, "Done: the flaky test is fixed.");
  const attach = () =>
    parts.bridge.attach({
      chatThreadKey: "slack:C1:500.1",
      channelId: "C1",
      threadId: "child-thread",
      createdByUserId: "",
      note: (chatKey) => `Your work is now this chat's. Chat key: ${chatKey}`,
    });
  return { ...parts, attach };
}

it("posts the answer of a subagent's run still going when its work is attached, once", async () => {
  const { t3, bridge, store, posted, attach } = subagentHarness("running");
  await attach();
  const binding = store.binding("slack:C1:500.1")!;
  assert.strictEqual(binding.threadId, "child-thread");
  // The run in flight is told about the chat, with the key it needs for the chat tools.
  const sends = t3.calls.filter((call) => call.tool === "t3_thread_send");
  assert.lengthOf(sends, 1);
  assert.include(String(sends[0]!.args.message), `Chat key: ${binding.chatKey}`);
  // Attaching again changes nothing.
  await attach();
  assert.lengthOf(
    t3.calls.filter((call) => call.tool === "t3_thread_send"),
    1,
  );
  t3.finish("child-1", "completed", "Done: the flaky test is fixed.");
  await bridge.idle();
  assert.deepStrictEqual(posted, [
    { chatThreadKey: "slack:C1:500.1", text: "Done: the flaky test is fixed." },
  ]);
});

it("posts the answer of a subagent's run that ended before its work was attached, once", async () => {
  const { t3, bridge, posted, attach } = subagentHarness("completed");
  await attach();
  await bridge.idle();
  await attach();
  await bridge.idle();
  // Nothing is sent to the finished child, so no run of its own starts.
  assert.lengthOf(
    t3.calls.filter((call) => call.tool === "t3_thread_send"),
    0,
  );
  assert.deepStrictEqual(posted, [
    { chatThreadKey: "slack:C1:500.1", text: "Done: the flaky test is fixed." },
  ]);
});

it("attaches any thread to one conversation, and moves a bound conversation only when asked", async () => {
  const { t3, bridge, store } = subagentHarness("completed");
  const refusal = (chatThreadKey: string | undefined, replace = false) =>
    bridge.attachRefusal({ threadId: "child-thread", chatThreadKey, replace });
  assert.isUndefined(await refusal(undefined));
  await bridge.receive(event("100.1"));
  // The conversation already goes to another thread.
  assert.include(await refusal("slack:C1:100.1"), "replace: true");
  assert.isUndefined(await refusal("slack:C1:100.1", true));
  await bridge.attach({
    chatThreadKey: "slack:C1:100.1",
    channelId: "C1",
    threadId: "child-thread",
    createdByUserId: "",
    note: () => "",
  });
  assert.strictEqual(store.binding("slack:C1:100.1")?.threadId, "child-thread");
  // The child answers that conversation now, and no other.
  assert.include(await refusal("slack:C1:900.1"), "already answers slack:C1:100.1");
  // Any thread may take a conversation, such as one connecting itself, not only a subagent.
  store.replaceBinding({ ...store.binding("slack:C1:100.1")!, threadId: "other-thread" });
  Object.assign(t3.thread, { parentThreadId: null, relationshipToParent: null });
  assert.isUndefined(await refusal(undefined));
});

it("keeps following background work across a restart, and posts the run it starts once", async () => {
  const db = freshDatabase();
  const before = harness(db);
  const { t3 } = before;
  await before.bridge.receive(event("100.1"));
  t3.options.delegatedPending = true;
  t3.finish("run-1", "completed", "Started the tests; they're still running.");
  // The answer posts, then the bridge waits on the background work, with the follow saved.
  await t3.tick();
  assert.deepStrictEqual(
    before.posted.map((reply) => reply.text),
    ["Started the tests; they're still running."],
  );
  assert.lengthOf(before.store.follows(), 1);
  before.bridge.stop();

  const after = harness(db, { t3 });
  await after.bridge.resume();
  // The background work reports back in a run T3 starts with a notification.
  t3.activity.push({ itemId: "wake", type: "notification", runId: "run-7", status: "completed" });
  t3.finish("run-7", "completed", "The tests passed.");
  t3.options.delegatedPending = false;
  await t3.tick();
  await after.bridge.idle();
  assert.deepStrictEqual(
    after.posted.map((reply) => reply.text),
    ["The tests passed."],
  );
  // The stopped bridge posted nothing more, and the follow is over.
  assert.lengthOf(before.posted, 1);
  assert.lengthOf(after.store.follows(), 0);
  // Another restart owes nothing again.
  const again = harness(db, { t3 });
  await again.bridge.resume();
  await again.bridge.idle();
  assert.lengthOf(again.posted, 0);
});

/** Runs the bridge's next scheduled look for notification runs, once. */
function pollNotifications(
  scheduledRuns: Array<{ readonly ms: number; readonly run: () => void }>,
): void {
  const index = scheduledRuns.findLastIndex((each) => each.ms === NOTIFICATION_POLL_MS);
  if (index === -1) return;
  const [next] = scheduledRuns.splice(index, 1);
  next!.run();
}

it("posts the answer of a run background work starts after T3 calls the work settled", async () => {
  const { t3, bridge, posted, scheduledRuns } = harness();
  await bridge.resume();
  await bridge.receive(event("100.1"));
  // T3 counts a background command only when the agent awaits it, so it calls the
  // work settled while the tests still run, and the follow ends.
  t3.finish("run-1", "completed", "Started the tests in the background.");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Started the tests in the background."],
  );
  // The command finishes after that, and T3 starts a run with its notification.
  t3.activity.push({ itemId: "wake", type: "notification", runId: "run-7", status: "completed" });
  t3.finish("run-7", "completed", "The tests passed.");
  pollNotifications(scheduledRuns);
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Started the tests in the background.", "The tests passed."],
  );
  // Later looks owe it nothing again.
  pollNotifications(scheduledRuns);
  await bridge.idle();
  assert.lengthOf(posted, 2);
});

it("posts a notification run once when a follow and the notification watch both find it", async () => {
  const { t3, bridge, posted, scheduledRuns, db } = harness();
  await bridge.resume();
  await bridge.receive(event("100.1"));
  t3.options.delegatedPending = true;
  t3.finish("run-1", "completed", "Started a subagent.");
  await t3.tick();
  // The subagent reports back while the follow is still watching.
  t3.activity.push({ itemId: "wake", type: "notification", runId: "run-7", status: "running" });
  pollNotifications(scheduledRuns);
  t3.options.delegatedPending = false;
  await t3.tick();
  pollNotifications(scheduledRuns);
  t3.finish("run-7", "completed", "subagent-result: done");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Started a subagent.", "subagent-result: done"],
  );
  assert.strictEqual(
    db.prepare("SELECT COUNT(*) AS owed FROM owed_reply WHERE run_id = 'run-7'").get()?.owed,
    1,
  );
});

it("leaves a run started by a message typed in T3 in T3", async () => {
  const { t3, bridge, posted, scheduledRuns } = harness();
  await bridge.resume();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", "Done.");
  await bridge.idle();
  t3.activity.push({ itemId: "typed", type: "user_message", runId: "run-8", status: "completed" });
  t3.finish("run-8", "completed", "An answer for the person in T3.");
  pollNotifications(scheduledRuns);
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Done."],
  );
});

it("posts a notification run that started while the bridge was down, once", async () => {
  const db = freshDatabase();
  const before = harness(db);
  const { t3 } = before;
  await before.bridge.resume();
  await before.bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", "Started the tests in the background.");
  await before.bridge.idle();
  before.bridge.stop();
  // The tests finish while the bridge restarts.
  t3.activity.push({ itemId: "wake", type: "notification", runId: "run-7", status: "completed" });
  t3.finish("run-7", "completed", "The tests passed.");

  const after = harness(db, { t3 });
  await after.bridge.resume();
  await after.bridge.idle();
  assert.deepStrictEqual(
    after.posted.map((reply) => reply.text),
    ["The tests passed."],
  );
  after.bridge.stop();
  const again = harness(db, { t3 });
  await again.bridge.resume();
  await again.bridge.idle();
  assert.lengthOf(again.posted, 0);
});

it("starts watching a thread bound before the notification watch at its end, so old runs stay unposted", async () => {
  const { t3, bridge, posted, scheduledRuns, store } = harness();
  // A conversation an older bridge bound, whose thread a notification woke and nobody answered.
  store.insertBinding({
    chatThreadKey: "slack:C1:100.1",
    channelId: "C1",
    projectId: PROJECT,
    threadId: THREAD,
    chatKey: "key",
    createdByUserId: "U1",
  });
  t3.options.pagedReads = true;
  t3.activity.push({ itemId: "old", type: "notification", runId: "run-5", status: "completed" });
  t3.finish("run-5", "completed", "An answer from before.");
  await bridge.resume();
  await bridge.idle();
  assert.lengthOf(posted, 0);
  // A run that starts afterwards is the chat's.
  t3.later.push({ itemId: "wake", type: "notification", runId: "run-7", status: "completed" });
  t3.finish("run-7", "completed", "The tests passed.");
  pollNotifications(scheduledRuns);
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["The tests passed."],
  );
});

it("says so in the chat when six hours pass with background work still running", async () => {
  let clock = 0;
  const { t3, bridge, posted, store } = harness(freshDatabase(), { now: () => clock });
  await bridge.receive(event("100.1"));
  t3.options.delegatedPending = true;
  t3.finish("run-1", "completed", "Started a long job.");
  await t3.tick();
  clock = 7 * 60 * 60 * 1000;
  // A subagent's run would be watched with this tick too; here only the follow waits.
  void t3.tick();
  await bridge.idle();
  assert.deepStrictEqual(posted.map((reply) => reply.text).slice(0, 1), ["Started a long job."]);
  assert.include(posted.at(-1)!.text, "six hours");
  assert.lengthOf(posted, 2);
  assert.lengthOf(store.follows(), 0);
});

it("leaves ending the turn to a later owed answer when a subagent's first wake is quiet", async () => {
  const { t3, bridge, posted, quieted } = harness();
  await bridge.receive(event("100.1"));
  t3.options.delegatedPending = true;
  t3.finish("run-1", "completed", "Started a subagent.");
  await t3.tick();
  t3.activity.push({ itemId: "wake-5", type: "notification", runId: "run-5", status: "running" });
  t3.activity.push({ itemId: "wake-6", type: "notification", runId: "run-6", status: "running" });
  t3.options.delegatedPending = false;
  await t3.tick();
  t3.finish("run-5", "completed", "NO_REPLY");
  await t3.tick();
  // run-6 is still owed, so its answer ends the turn, not a quiet note.
  assert.lengthOf(quieted, 0);
  t3.finish("run-6", "completed", "subagent-result: done");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Started a subagent.", "subagent-result: done"],
  );
  assert.lengthOf(quieted, 0);
});

it("posts the answers of runs that end together in the order they were owed", async () => {
  const { t3, bridge, posted } = harness();
  await bridge.receive(event("100.1"));
  t3.options.delegatedPending = true;
  t3.finish("run-1", "completed", "Started a subagent.");
  await t3.tick();
  // The subagent's two completions start two runs, one after the other.
  t3.activity.push({ itemId: "wake-5", type: "notification", runId: "run-5", status: "running" });
  t3.activity.push({ itemId: "wake-6", type: "notification", runId: "run-6", status: "running" });
  t3.options.delegatedPending = false;
  await t3.tick();
  // The later run's answer is ready first.
  t3.finish("run-6", "completed", "subagent-result: done");
  t3.finish("run-5", "completed", "subagent-result: still waiting");
  await bridge.idle();
  assert.deepStrictEqual(
    posted.map((reply) => reply.text),
    ["Started a subagent.", "subagent-result: still waiting", "subagent-result: done"],
  );
});

it("posts nothing for a run that answers NO_REPLY, and tells every chat how to", async () => {
  const { t3, bridge, posted, quieted } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", " `NO_REPLY`. ");
  await bridge.idle();
  assert.lengthOf(posted, 0);
  // The platform still hears the run ended, so a Linear session can stop showing work.
  assert.deepStrictEqual(quieted, ["slack:C1:100.1"]);
  // Only a final message that is the marker alone stays quiet.
  assert.isTrue(isQuietReply("NO_REPLY"));
  assert.isFalse(isQuietReply("NO_REPLY was wrong earlier; here are the logs."));
  assert.isFalse(isQuietReply("No reply needed"));
  // Slack posts only through chat_post, so it has no use for the marker.
  assert.notInclude(slackFirstTurnNote("key"), QUIET_REPLY);
});

it("posts nothing when a run completes on a silent platform, whatever its final message", async () => {
  const { t3, bridge, posted, store } = harness(undefined, { slack: { silentByDefault: true } });
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", "All done, tests pass.");
  await bridge.idle();
  assert.lengthOf(posted, 0);
  // Not owed any more: a restart doesn't post it either.
  assert.lengthOf(store.pendingReplies(), 0);
  // A follow-up turn tells the agent how to reach the chat.
  await bridge.receive(event("100.2", { kind: "follow_up", text: "and the lint?" }));
  const send = t3.calls.find((call) => call.tool === "t3_thread_send")!;
  assert.include(
    String(send.args.message),
    "Only chat_post reaches the Slack thread, with kind question, blocked, done or answer.",
  );
  // A failed run still says so.
  const failing = harness(undefined, { slack: { silentByDefault: true } });
  await failing.bridge.receive(event("100.1"));
  failing.t3.finish("run-1", "failed");
  await failing.bridge.idle();
  assert.deepStrictEqual(
    failing.posted.map((reply) => reply.text),
    ["The run failed. Open the thread in T3 Code for details."],
  );
});

it("makes Slack and iMessage silent by default, and tells their agents when to post", () => {
  const imessage = imessagePlatform({
    chat: () => undefined,
    adapter: { isDM: () => false, canReact: false } as unknown as ImessageAdapter,
    access: { allowedUserIds: [] },
    route: { projectId: PROJECT },
    onEvent: async () => ({ type: "pending" }),
  }).platform;
  assert.isTrue(SLACK.silentByDefault);
  assert.isTrue(imessage.silentByDefault);
  const imessageNote = imessage.firstTurnNote("key", event("1"));
  for (const note of [slackFirstTurnNote("key"), imessageNote]) {
    assert.include(note, "Only chat_post reaches this");
    for (const kind of ["`question`", "`blocked`", "`done`", "`answer`"])
      assert.include(note, kind);
    assert.include(note, "post only for those addressed to you that need your answer");
    assert.notInclude(note, QUIET_REPLY);
    assert.notInclude(note, "final message in each run is");
  }
  assert.include(slackFirstTurnNote("key"), "chat_react (eyes)");
  assert.include(slackFirstTurnNote("key"), "chat_status");
  assert.notInclude(SLACK_REPLY_STYLE, "progress update");
  assert.include(imessageNote, "group conversation");
});

it("asks for an acknowledgement in the first turn only, and the reply style in every turn", async () => {
  // Office asks for it, and the harness platform mirrors that; Slack acknowledges with a reaction instead.
  assert.isUndefined(SLACK.acknowledgeFirst);
  const { t3, bridge } = harness();
  await bridge.receive(event("100.1"));
  const launch = t3.calls.find((call) => call.tool === "t3_thread_launch")!;
  assert.include(String(launch.args.message), ACKNOWLEDGE_FIRST);
  await bridge.receive(event("100.2", { kind: "follow_up", text: "also lint" }));
  const send = t3.calls.find((call) => call.tool === "t3_thread_send")!;
  assert.include(String(send.args.message), "also lint");
  assert.notInclude(String(send.args.message), ACKNOWLEDGE_FIRST);
  for (const message of [launch.args.message, send.args.message])
    assert.strictEqual(String(message).split(SLACK_REPLY_STYLE).length, 2);
  t3.finish("run-1", "completed", "Done.");
  await bridge.idle();
});

it("shows the thread processing while delegated work goes on after the turn, refreshed until it settles", async () => {
  const { t3, bridge, statuses, scheduledRuns } = harness();
  await bridge.receive(event("100.1"));
  t3.options.delegatedPending = true;
  t3.finish("run-1", "completed", "Started the tests; I'll post the results.");
  await t3.tick();
  const background = `slack:C1:100.1 processing ${BACKGROUND_STATUS}`;
  // The turn ends, and the background status follows it.
  const ended = statuses.lastIndexOf("slack:C1:100.1 active");
  assert.isAbove(ended, -1);
  assert.include(statuses.slice(ended), background);
  // Refreshed on the injected scheduler, about once a minute.
  const refresh = scheduledRuns.filter((each) => each.ms === 60_000);
  assert.lengthOf(refresh, 1);
  const before = statuses.length;
  refresh[0]!.run();
  assert.deepStrictEqual(statuses.slice(before), [background]);
  assert.lengthOf(
    scheduledRuns.filter((each) => each.ms === 60_000),
    2,
  );
  // The work settles: the status clears, and a late refresh sets nothing.
  t3.options.delegatedPending = false;
  void t3.tick();
  await bridge.idle();
  assert.strictEqual(statuses.at(-1), "slack:C1:100.1 active");
  const after = statuses.length;
  scheduledRuns.at(-1)!.run();
  assert.lengthOf(statuses, after);
});

it("tells a reply turn to answer only the new message while earlier delegated work still runs", async () => {
  const { t3, bridge } = harness();
  await bridge.receive(event("100.1"));
  t3.options.delegatedPending = true;
  t3.finish("run-1", "completed", "Here's what I found; a second check is still running.");
  await t3.tick();
  // The reply crosses the second check, as in the thread that repeated itself.
  await bridge.receive(event("100.2", { kind: "follow_up", text: "u failed to tag andrew" }));
  const sends = () => t3.calls.filter((call) => call.tool === "t3_thread_send");
  assert.include(String(sends()[0]!.args.message), WORK_RUNNING_NOTE);
  // Once the work settles, a reply gets no such line.
  t3.options.delegatedPending = false;
  void t3.tick();
  await bridge.idle();
  await bridge.receive(event("100.3", { kind: "follow_up", text: "thanks" }));
  assert.lengthOf(sends(), 2);
  assert.notInclude(String(sends()[1]!.args.message), WORK_RUNNING_NOTE);
});

it("adds no delegated-work line to a reply when no work was ever running", async () => {
  const { t3, bridge } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  await bridge.receive(event("100.2", { kind: "follow_up", text: "also lint" }));
  const send = t3.calls.find((call) => call.tool === "t3_thread_send")!;
  assert.notInclude(String(send.args.message), WORK_RUNNING_NOTE);
});

it("leaves the state alone after the turn when no delegated work is going", async () => {
  const { t3, bridge, statuses } = harness();
  await bridge.receive(event("100.1"));
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  assert.notInclude(statuses, `slack:C1:100.1 processing ${BACKGROUND_STATUS}`);
  assert.strictEqual(statuses.at(-1), "slack:C1:100.1 active");
});

it("finishes a launched message before its follow-on work, so a restart doesn't send it again", async () => {
  const db = freshDatabase();
  const first = harness(db);
  // T3 took the launch; the process dies while it asks T3 for a title.
  const titling = first.t3.hang("t3_thread_update");
  void first.bridge.receive(event("100.1"));
  await titling;
  first.bridge.stop();

  const second = harness(db, { t3: first.t3 });
  await second.bridge.resume();
  assert.lengthOf(
    second.t3.calls.filter((call) => call.tool === "t3_thread_launch"),
    1,
  );
  assert.isUndefined(second.t3.calls.find((call) => call.tool === "t3_thread_send"));
  second.t3.finish("run-1", "completed", "Done once.");
  await second.bridge.idle();
  assert.deepStrictEqual(
    second.posted.map((reply) => reply.text),
    ["Done once."],
  );
});

it("sends a follow-up with files once when T3 took it but its reply was lost", async () => {
  const { t3, bridge, store, advance } = harness();
  await bridge.receive(event("100.1"));
  t3.options.loseAttachmentReply = true;
  const followUp = event("100.2", {
    kind: "follow_up",
    text: "see the log",
    files: [{ name: "log.txt", mimeType: "text/plain", sizeBytes: 3, url: "https://files/log" }],
  });
  assert.deepStrictEqual(await bridge.receive(followUp), { type: "pending" });
  advance(15_000);
  await bridge.resume();

  const sends = t3.calls.filter((call) => call.tool === "t3_thread_send_attachments");
  assert.lengthOf(sends, 2);
  assert.strictEqual(sends[0]!.args.clientRequestId, "chat-bridge:slack:C1:100.2");
  assert.strictEqual(sends[1]!.args.clientRequestId, sends[0]!.args.clientRequestId);
  assert.strictEqual(t3.attachmentSends.size, 1, "T3 made one message");
  assert.isTrue(store.isHandled("slack:C1:100.2"));
});

it("asks a question again after posting it failed, and takes no message as its answer meanwhile", async () => {
  const { t3, bridge, blockPosts } = harness(freshDatabase(), { questionPostFailures: 1 });
  await bridge.receive(event("100.1"));
  t3.questions.set("req-1", [
    {
      id: "q1",
      header: "Deploy",
      question: "Which environment?",
      options: [
        { label: "Staging", description: "Safe" },
        { label: "Production", description: "Live" },
      ],
    },
  ]);
  t3.activity.push({
    itemId: "ask",
    type: "user_input_request",
    runId: "run-1",
    status: "waiting",
  });
  await t3.tick();
  assert.lengthOf(blockPosts, 0);
  // Nobody has seen the question, so a message goes to the agent instead of answering it.
  const meanwhile = await bridge.receive(event("100.2", { kind: "follow_up", text: "Staging" }));
  assert.strictEqual(meanwhile.type, "followed_up");
  assert.isUndefined(t3.calls.find((call) => call.args.action === "respond"));

  await t3.tick();
  assert.lengthOf(blockPosts, 1);
  await t3.tick();
  assert.lengthOf(blockPosts, 1, "asked once it reached the chat");
  t3.activity[0]!.status = "completed";
  t3.finish("run-1", "completed", "Done.");
  await bridge.idle();
});

it("posts an answer after a restart between claiming it and posting it, with the same delivery id", async () => {
  const db = freshDatabase();
  const deliveries: Array<string | undefined> = [];
  let posting = () => {};
  const reached = new Promise<void>((resolve) => (posting = resolve));
  const first = harness(db, {
    post: (message: OutboundMessage) => {
      deliveries.push(message.eventId);
      posting();
      return new Promise<void>(() => {});
    },
  });
  await first.bridge.receive(event("100.1"));
  first.t3.finish("run-1", "completed", "Fixed.");
  await reached;
  first.bridge.stop();

  const posted: Array<string> = [];
  const second = harness(db, {
    t3: first.t3,
    post: async (message: OutboundMessage) => {
      deliveries.push(message.eventId);
      posted.push(message.text);
    },
  });
  await second.bridge.resume();
  await second.bridge.idle();
  assert.deepStrictEqual(posted, ["Fixed."]);
  assert.deepStrictEqual(deliveries, ["answer:thread-1:run-1", "answer:thread-1:run-1"]);
  assert.deepStrictEqual(second.store.pendingReplies(), []);
});

/**
 * The bridge's Slack adapter on a real `Chat`, fed by Office's relay, wired as
 * `bin.ts` wires it. Slack's Web API points at an address that refuses
 * connections, so user lookups fail and names fall back to ids.
 */
async function relayedSlack(
  bridge: Bridge,
  db: NodeSqlite.DatabaseSync,
  options: {
    /** Stands in for the Slack host's hand-off of each SDK message to the core. */
    deliver?: (handOff: () => Promise<void>) => Promise<void>;
    /** Marking rows delivered fails, as when Office is unreachable. */
    deliveredFails?: boolean;
    sleep?: (ms: number) => Promise<void>;
    timeout?: (ms: number) => Promise<void>;
    /** Slack's Web API, such as a `fakeSlackApi`; by default an address that refuses. */
    apiUrl?: string;
  } = {},
) {
  const slackParts = createSlackHost({
    botToken: "xoxb-test",
    transport: { kind: "office-relay" },
    botUserId: "UBOT",
    apiUrl: options.apiUrl ?? "http://127.0.0.1:9/api/",
    onEvent: (inbound) => bridge.receive(inbound),
  });
  const chat = await startChatHost({
    adapters: { slack: slackParts.adapter },
    deliver: {
      slack: (thread, message, context, route) => {
        const handOff = () => slackParts.deliver(thread, message, context, route);
        return options.deliver ? options.deliver(handOff) : handOff();
      },
    },
    state: createChatState(db, {
      reclaim: (key) => currentRelayedRow()?.redispatch === true && isChatSdkDedupeKey(key),
    }),
    onError: (error) => assert.fail(String(error)),
    onAnswer: (chatThreadKey, userId, value) =>
      bridge.questionClicked(chatThreadKey, userId, value),
    onStop: (chatThreadKey, userId) =>
      bridge.stopRequested(chatThreadKey, userId, currentRelayedRow()?.eventTimeMs),
    log: () => {},
  });
  let push: (rows: ReadonlyArray<SlackInboxRow>) => void = () => {};
  const delivered: Array<{ ids: ReadonlyArray<string>; handled: boolean }> = [];
  let handled = () => false;
  const relay = connectSlackRelay({
    transport: "office-relay",
    source: {
      subscribeSlackInbox: (onRows) => {
        push = onRows;
        return () => {};
      },
      slackDelivered: async (ids) => {
        if (options.deliveredFails === true) throw new Error("Office is unreachable");
        delivered.push({ ids, handled: handled() });
      },
    },
    store: new BridgeStore(db),
    chat,
    log: () => {},
    sleep: options.sleep ?? (async () => {}),
    // No row here runs long enough to time out, unless the test says.
    timeout: options.timeout ?? (() => new Promise<void>(() => {})),
  })!;
  return {
    /** The Slack-only calls, as `bin.ts` gets them once the `Chat` runs. */
    host: slackParts.connect(chat),
    delivered,
    /** What `delivered` records about the bridge when each batch is marked. */
    whenDelivered: (check: () => boolean) => (handled = check),
    push: (rows: ReadonlyArray<SlackInboxRow>) => push(rows),
    idle: () => relay.idle(),
    close: async () => {
      await relay.close();
      await chat.shutdown();
    },
  };
}

it("handles a relayed Slack mention, then marks the row delivered", async () => {
  const { t3, bridge, db } = harness();
  const slack = await relayedSlack(bridge, db);
  slack.whenDelivered(() => t3.calls.some((call) => call.tool === "t3_thread_launch"));
  slack.push([
    {
      id: "row-1",
      kind: "event",
      contentType: "application/json",
      retryNum: 0,
      rawBody: JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev1",
        event: {
          type: "app_mention",
          channel: "C1",
          channel_type: "channel",
          user: "U1",
          ts: "100.1",
          text: "<@UBOT> fix the build",
          team: "T1",
        },
      }),
    },
  ]);
  await slack.idle();
  assert.deepStrictEqual(slack.delivered, [{ ids: ["row-1"], handled: true }]);
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  await slack.close();
});

it("resolves a question from a relayed button click", async () => {
  const { t3, bridge, blockPosts, db } = harness();
  await bridge.receive(event("100.1"));
  t3.questions.set("req-1", [
    {
      id: "q1",
      header: "Deploy",
      question: "Which environment?",
      options: [
        { label: "Staging", description: "Safe" },
        { label: "Production", description: "Live", value: "prod" },
      ],
    },
  ]);
  t3.activity.push({
    itemId: "ask",
    type: "user_input_request",
    runId: "run-1",
    status: "waiting",
  });
  await t3.tick();
  const actions = blockPosts[0]!.blocks.find((block) => block.type === "actions") as {
    elements: Array<{ action_id: string; value: string }>;
  };
  const button = actions.elements[1]!;
  const slack = await relayedSlack(bridge, db);
  slack.whenDelivered(() => t3.calls.some((call) => call.args.action === "respond"));
  const payload = {
    type: "block_actions",
    user: { id: "U1", username: "ada", name: "Ada" },
    team: { id: "T1" },
    channel: { id: "C1" },
    container: { type: "message", channel_id: "C1", message_ts: "900.1", thread_ts: "100.1" },
    message: { ts: "900.1", thread_ts: "100.1" },
    trigger_id: "trigger-1",
    actions: [{ action_id: button.action_id, value: button.value }],
  };
  slack.push([
    {
      id: "row-2",
      kind: "interaction",
      contentType: "application/x-www-form-urlencoded",
      retryNum: 0,
      rawBody: `payload=${encodeURIComponent(JSON.stringify(payload))}`,
    },
  ]);
  await slack.idle();
  const respond = t3.calls.find((call) => call.args.action === "respond");
  assert.deepStrictEqual(respond?.args, {
    action: "respond",
    threadId: THREAD,
    requestId: "req-1",
    answers: { q1: "prod" },
  });
  assert.deepStrictEqual(slack.delivered, [{ ids: ["row-2"], handled: true }]);
  t3.activity[0]!.status = "completed";
  t3.finish("run-1", "completed", "Deployed.");
  await bridge.idle();
  await slack.close();
});

it("stops the run from a relayed agent_session_stopped event before marking it delivered", async () => {
  const { t3, bridge, db } = harness();
  await bridge.receive(event("100.1"));
  const slack = await relayedSlack(bridge, db);
  slack.whenDelivered(() => t3.calls.some((call) => call.tool === "t3_thread_interrupt"));
  slack.push([
    {
      id: "row-3",
      kind: "event",
      contentType: "application/json",
      retryNum: 0,
      rawBody: JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev3",
        event: { type: "agent_session_stopped", channel: "C1", thread_ts: "100.1", user: "U1" },
      }),
    },
  ]);
  await slack.idle();
  assert.deepStrictEqual(slack.delivered, [{ ids: ["row-3"], handled: true }]);
  t3.finish("run-1", "interrupted", "");
  await bridge.idle();
  await slack.close();
});

/** `retryNum` is Slack's: a row Office first received on Slack's retry carries 1. */
const relayedMention = (id: string, retryNum = 0): SlackInboxRow => ({
  id,
  kind: "event",
  contentType: "application/json",
  retryNum,
  rawBody: JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event_id: `Ev-${id}`,
    event: {
      type: "app_mention",
      channel: "C1",
      channel_type: "channel",
      user: "U1",
      ts: "100.1",
      event_ts: "100.1",
      text: "<@UBOT> fix the build",
      team: "T1",
    },
  }),
});

/** A press of Slack's stop button in thread 100.1, at `eventTs` (Slack's seconds) when given. */
const relayedStop = (id: string, eventTs?: string): SlackInboxRow => ({
  id,
  kind: "event",
  contentType: "application/json",
  retryNum: 0,
  rawBody: JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event_id: `Ev-${id}`,
    event: {
      type: "agent_session_stopped",
      channel: "C1",
      thread_ts: "100.1",
      user: "U1",
      ...(eventTs === undefined ? {} : { event_ts: eventTs }),
    },
  }),
});

/** A first try that gets past the Chat SDK's dedupe mark, then never reaches the core. */
function stallFirstHandOff() {
  let handOffs = 0;
  let stalled!: () => void;
  const reached = new Promise<void>((resolve) => (stalled = resolve));
  return {
    reached,
    handOffs: () => handOffs,
    deliver: (handOff: () => Promise<void>) => {
      handOffs += 1;
      if (handOffs > 1) return handOff();
      stalled();
      return new Promise<void>(() => {});
    },
  };
}

it("hands a relayed message to the core on a retry after a try stopped past the SDK's dedupe mark", async () => {
  const { t3, bridge, db } = harness();
  const first = stallFirstHandOff();
  const timers: Array<() => void> = [];
  const slack = await relayedSlack(bridge, db, {
    deliver: first.deliver,
    timeout: () => new Promise<void>((resolve) => void timers.push(resolve)),
  });
  const launches = () => t3.calls.filter((call) => call.tool === "t3_thread_launch").length;
  slack.whenDelivered(() => launches() === 1);
  // Office first got it on Slack's retry; the adapter's event-delivered mark must not skip it.
  slack.push([relayedMention("row-1", 1)]);
  await first.reached;
  // The stalled try times out; the retry must not be a no-op that gets the row marked delivered.
  for (const fire of timers.splice(0)) fire();
  await slack.idle();
  assert.strictEqual(first.handOffs(), 2);
  assert.strictEqual(launches(), 1);
  assert.deepStrictEqual(slack.delivered, [{ ids: ["row-1"], handled: true }]);
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  await slack.close();
});

it("hands a relayed message to the core after a restart that cut its first try short", async () => {
  const { t3, bridge, db } = harness();
  // The first process gets past the SDK's dedupe mark, then dies.
  const first = stallFirstHandOff();
  const before = await relayedSlack(bridge, db, { deliver: first.deliver });
  // Office first got it on Slack's retry; the adapter's event-delivered mark must not skip it.
  before.push([relayedMention("row-1", 1)]);
  await first.reached;

  const after = await relayedSlack(bridge, db);
  const launches = () => t3.calls.filter((call) => call.tool === "t3_thread_launch").length;
  after.whenDelivered(() => launches() === 1);
  after.push([relayedMention("row-1", 1)]);
  await after.idle();
  assert.strictEqual(launches(), 1);
  assert.deepStrictEqual(after.delivered, [{ ids: ["row-1"], handled: true }]);
  t3.finish("run-1", "completed", "Fixed.");
  await bridge.idle();
  await after.close();
});

it("only marks delivered a stop row handled before a restart, without stopping again", async () => {
  const { t3, bridge, db } = harness();
  await bridge.receive(event("100.1"));
  const interrupts = () => t3.calls.filter((call) => call.tool === "t3_thread_interrupt").length;
  // The first process stops the run, then dies before Office hears the row was delivered.
  let markFailed!: () => void;
  const markingFailed = new Promise<void>((resolve) => (markFailed = resolve));
  const before = await relayedSlack(bridge, db, {
    deliveredFails: true,
    sleep: () => {
      markFailed();
      return new Promise<void>(() => {});
    },
  });
  before.push([relayedStop("row-3")]);
  await markingFailed;
  assert.strictEqual(interrupts(), 1);

  const after = await relayedSlack(bridge, db);
  after.push([relayedStop("row-3")]);
  await after.idle();
  assert.strictEqual(interrupts(), 1);
  assert.deepStrictEqual(after.delivered, [{ ids: ["row-3"], handled: false }]);
  t3.finish("run-1", "interrupted", "");
  await bridge.idle();
  await after.close();
});

it("ignores a relayed stop from before the thread's latest run was asked for", async () => {
  const { t3, bridge, db } = harness();
  await bridge.receive(event("100.1"));
  // T3 lists the run as asked for at 10:00:05 UTC; Slack times are seconds since the epoch.
  const runAsked = 1_762_682_405_000;
  t3.options.recentRuns = [
    { runId: "run-1", ordinal: 1, status: "running", requestedAt: "2025-11-09T10:00:05.000Z" },
  ];
  const interrupts = () => t3.calls.filter((call) => call.tool === "t3_thread_interrupt").length;
  const slack = await relayedSlack(bridge, db);
  slack.push([relayedStop("row-old", String((runAsked - 60_000) / 1000))]);
  await slack.idle();
  assert.strictEqual(interrupts(), 0);
  assert.deepStrictEqual(
    slack.delivered.flatMap((batch) => batch.ids),
    ["row-old"],
  );

  // A stop that looks a few seconds early, because Slack's clock and the host's differ, still stops it.
  slack.push([relayedStop("row-skewed", String((runAsked - 3_000) / 1000))]);
  await slack.idle();
  assert.strictEqual(interrupts(), 1);
  t3.finish("run-1", "interrupted", "");
  await bridge.idle();
  await slack.close();
});

it("resends a relayed message its dedupe dropped, so the next start hands it on once", async () => {
  const db = freshDatabase();
  const first = harness(db);
  const launches = (t3: ReturnType<typeof fakeT3>) =>
    t3.calls.filter((call) => call.tool === "t3_thread_launch").length;
  // A try that got past both dedupe marks and never reached T3, as in production.
  first.store.markHandled("slack:C1:100.1");
  const slack = await relayedSlack(first.bridge, db);
  await createChatState(db).set("dedupe:slack:100.1", true, 60_000);
  // Office records the row again under a new event id: both marks drop it.
  slack.push([relayedMention("row-2")]);
  await slack.idle();
  assert.strictEqual(launches(first.t3), 0);
  await slack.close();
  first.bridge.stop();

  const api = await fakeSlackApi({
    "users.info": (args) => ({ ok: true, user: { id: args.user, name: "ada", real_name: "Ada" } }),
    "conversations.replies": (args) => {
      assert.strictEqual(args.ts, "100.1");
      return { ok: true, messages: [{ ts: "100.1", user: "U1", text: "<@UBOT> fix the build" }] };
    },
  });
  try {
    const host = createSlackHost({
      botToken: "xoxb-test",
      transport: { kind: "office-relay" },
      botUserId: "UBOT",
      apiUrl: api.apiUrl,
      onEvent: async () => ({ type: "pending" }),
    }).connect({} as Chat);
    const store = new BridgeStore(db);
    // The bridge's own process never counts as the running one; another live one does.
    store.setMeta(RUNNING_PID_KEY, "4242");
    assert.strictEqual(
      runningBridge(store, (pid) => pid === 4242),
      4242,
    );
    assert.isUndefined(runningBridge(store, () => false));
    const resent = await resendSlackMessage({
      db,
      store,
      channel: "C1",
      ts: "100.1",
      messageEvent: host.messageEvent,
    });
    assert.deepInclude(resent, {
      eventId: "slack:C1:100.1",
      kind: "mention",
      text: "fix the build",
    });
  } finally {
    await api.close();
  }

  const second = harness(db);
  await second.bridge.resume();
  assert.strictEqual(launches(second.t3), 1);
  const launch = second.t3.calls.find((call) => call.tool === "t3_thread_launch")!;
  assert.include(String(launch.args.message), "fix the build");
  // Handled once: the same message again, live or relayed, is a duplicate.
  assert.deepStrictEqual(await second.bridge.receive(event("100.1")), {
    type: "ignored",
    reason: "duplicate",
  });
  second.t3.finish("run-1", "completed", "Fixed.");
  await second.bridge.idle();
  assert.deepStrictEqual(second.posted, [{ chatThreadKey: "slack:C1:100.1", text: "Fixed." }]);
});

it("refuses to resend a message that already reached T3, so a restart never runs it twice", async () => {
  const db = freshDatabase();
  const first = harness(db);
  const handOffs = (t3: ReturnType<typeof fakeT3>) =>
    t3.calls.filter((call) => call.tool === "t3_thread_launch" || call.tool === "t3_thread_send")
      .length;
  // The opening message launches the thread; a reply in it is sent into the thread.
  assert.deepStrictEqual(await first.bridge.receive(event("100.1")), {
    type: "started",
    threadId: THREAD,
  });
  first.t3.finish("run-1", "completed", "Fixed.");
  await first.bridge.idle();
  await first.bridge.receive(
    event("100.2", { kind: "follow_up", addressed: false, text: "and the tests" }),
  );
  assert.strictEqual(handOffs(first.t3), 2);
  first.t3.finish("run-1", "completed", "Done.");
  await first.bridge.idle();
  first.bridge.stop();
  // Bridges from before this was recorded still know which message launched the thread.
  db.prepare("DELETE FROM delivered_message WHERE event_id = ?").run("slack:C1:100.1");

  const api = await fakeSlackApi({
    "users.info": (args) => ({ ok: true, user: { id: args.user, name: "ada", real_name: "Ada" } }),
    "conversations.replies": (args) => ({
      ok: true,
      messages: [
        { ts: "100.1", user: "U1", text: "<@UBOT> fix the build" },
        { ts: "100.2", user: "U1", text: "and the tests", thread_ts: "100.1" },
      ].filter((message) => message.ts === args.ts),
    }),
  });
  try {
    const host = createSlackHost({
      botToken: "xoxb-test",
      transport: { kind: "office-relay" },
      botUserId: "UBOT",
      apiUrl: api.apiUrl,
      onEvent: async () => ({ type: "pending" }),
    }).connect({} as Chat);
    // The Chat SDK's state lives in the same database, as in production.
    createChatState(db);
    const store = new BridgeStore(db);
    for (const ts of ["100.1", "100.2"]) {
      let refused: unknown;
      try {
        await resendSlackMessage({ db, store, channel: "C1", ts, messageEvent: host.messageEvent });
      } catch (error) {
        refused = error;
      }
      assert.instanceOf(refused, Error);
      assert.include(
        (refused as Error).message,
        `slack:C1:${ts} already reached T3 thread ${THREAD}`,
      );
      assert.isTrue(store.isHandled(`slack:C1:${ts}`));
    }
  } finally {
    await api.close();
  }

  const second = harness(db);
  await second.bridge.resume();
  assert.strictEqual(handOffs(second.t3), 0);
  await second.bridge.idle();
  assert.deepStrictEqual(second.posted, []);
});

it("reads nothing back from Slack on a start with Office's relay, and still drains saved events", async () => {
  /** A restart after a bound Slack thread got a reply the bridge saved and didn't hand on. */
  const restart = async (transport: SlackTransport) => {
    const db = freshDatabase();
    const first = harness(db);
    first.setClock(1_762_682_400_000);
    // A first start only sets the read-up-to mark.
    await first.bridge.catchUp("slack", undefined);
    await first.bridge.receive(event("100.1"));
    first.t3.finish("run-1", "completed", "Fixed.");
    await first.bridge.idle();
    const saved = event("100.2", { kind: "follow_up", addressed: false, text: "and the tests" });
    first.store.enqueue({
      eventId: saved.eventId,
      chatThreadKey: saved.chatThreadKey,
      event: JSON.stringify(saved),
    });
    first.bridge.stop();

    const api = await fakeSlackApi({
      "users.info": (args) => ({
        ok: true,
        user: { id: args.user, name: "ada", real_name: "Ada" },
      }),
      "conversations.replies": () => ({
        ok: true,
        messages: [{ ts: "100.1", user: "U1", text: "<@UBOT> fix the build" }],
      }),
      "conversations.history": () => ({ ok: true, messages: [] }),
    });
    const second = harness(db);
    second.setClock(1_762_682_460_000);
    try {
      const host = createSlackHost({
        botToken: "xoxb-test",
        transport,
        botUserId: "UBOT",
        apiUrl: api.apiUrl,
        onEvent: (inbound) => second.bridge.receive(inbound),
      }).connect({} as Chat);
      // The order `start` runs them in: the inbox, then Slack's catch-up.
      await second.bridge.resume();
      await second.bridge.catchUp("slack", host.missedEvents);
      const sent = second.t3.calls.filter((call) => call.tool === "t3_thread_send");
      second.t3.finish("run-0", "completed", "Done.");
      await second.bridge.idle();
      second.bridge.stop();
      return {
        reads: api.calls
          .map((call) => call.method)
          .filter((method) => method.startsWith("conversations.")),
        sent: sent.map((call) => String(call.args.message)),
        inbox: second.store.inboxThreads(),
      };
    } finally {
      await api.close();
    }
  };

  const relayed = await restart({ kind: "office-relay" });
  assert.deepStrictEqual(relayed.reads, []);
  assert.lengthOf(relayed.sent, 1);
  assert.include(relayed.sent[0], "and the tests");
  assert.deepStrictEqual(relayed.inbox, []);
  // Socket Mode, which has no relay, reads the bound thread back on the same start.
  const socket = await restart({ kind: "socket", appToken: "xapp-test" });
  assert.include(socket.reads, "conversations.replies");
  assert.lengthOf(socket.sent, 1);
});

/** A Slack harness whose platform records each run it is told ended, as Office's article staging is. */
function releaseHarness(
  options: { t3?: ReturnType<typeof fakeT3>; db?: NodeSqlite.DatabaseSync } = {},
) {
  const ended: Array<string> = [];
  const run = harness(options.db ?? freshDatabase(), {
    runEnded: async (_chatThreadKey, runId) => void ended.push(runId),
    allowEveryone: true,
    members: ["U1"],
    ...(options.t3 ? { t3: options.t3 } : {}),
  });
  return { ...run, ended };
}

it("tells the platform a run ended only once its delegated work settles", async () => {
  const h = releaseHarness();
  await h.bridge.receive(event("100.1", { text: "<@UOFFICE> fix the Rome FAQs" }));
  // The parent hands the work to a subagent and ends its turn.
  h.t3.options.delegatedPending = true;
  h.t3.finish("run-1", "completed", "A subagent is staging the edits.");
  await h.t3.tick();
  assert.deepStrictEqual(h.ended, []);
  // The subagent settles: only now does the run end.
  h.t3.options.delegatedPending = false;
  void h.t3.tick();
  await h.bridge.idle();
  assert.deepStrictEqual(h.ended, ["run-1"]);
});

/** Ticks the fake T3's waits until `done` holds, so a follow gets through its next checks. */
async function tickUntil(
  t3: ReturnType<typeof fakeT3>,
  done: () => boolean,
  most = 10,
): Promise<void> {
  for (let ticks = 0; ticks < most && !done(); ticks += 1) await t3.tick();
  assert.isTrue(done(), `still waiting after ${most} ticks`);
}

/** Ada's first turn leaves a subagent working; her second turn, run-2, starts while it works. */
async function twoTurnsWithDelegatedWork(
  h: ReturnType<typeof releaseHarness>,
  pending: Set<string>,
) {
  h.t3.options.sendStartsRun = true;
  h.t3.options.delegatedPendingRuns = pending;
  await h.bridge.receive(event("100.1", { text: "<@UOFFICE> fix the Rome FAQs" }));
  pending.add("run-1");
  h.t3.finish("run-1", "completed", "A subagent is staging the edits.");
  await h.t3.tick();
  await h.bridge.receive(
    event("100.2", { kind: "follow_up", addressed: false, text: "and the Paris page" }),
  );
}

it("ends a later run when its own work settles, while the earlier run's work goes on", async () => {
  const h = releaseHarness();
  const pending = new Set<string>();
  await twoTurnsWithDelegatedWork(h, pending);
  // run-2 started no delegated work of its own, so it doesn't wait for run-1's.
  h.t3.finish("run-2", "completed", "Done.");
  await tickUntil(h.t3, () => h.ended.length === 1);
  assert.deepStrictEqual(h.ended, ["run-2"]);
  pending.delete("run-1");
  void h.t3.tick();
  await h.bridge.idle();
  assert.deepStrictEqual(h.ended, ["run-2", "run-1"]);
});

it("keeps a later run going while its own delegated work goes on after the earlier run's settles", async () => {
  const h = releaseHarness();
  const pending = new Set<string>();
  await twoTurnsWithDelegatedWork(h, pending);
  pending.add("run-2");
  h.t3.finish("run-2", "completed", "Another subagent is on Paris.");
  await h.t3.tick();
  // run-1's subagent settles first: only run-1 ends.
  pending.delete("run-1");
  await tickUntil(h.t3, () => h.ended.length === 1);
  assert.deepStrictEqual(h.ended, ["run-1"]);
  await h.t3.tick();
  await h.t3.tick();
  assert.deepStrictEqual(h.ended, ["run-1"]);
  pending.delete("run-2");
  void h.t3.tick();
  await h.bridge.idle();
  assert.deepStrictEqual(h.ended, ["run-1", "run-2"]);
});

it("ends a joined run after a restart once its own delegated work settles", async () => {
  const db = freshDatabase();
  const first = releaseHarness({ db });
  const pending = new Set<string>();
  await twoTurnsWithDelegatedWork(first, pending);
  pending.add("run-2");
  first.t3.finish("run-2", "completed", "Another subagent is on Paris.");
  await first.t3.tick();
  first.bridge.stop();
  assert.deepStrictEqual(first.ended, []);

  const second = releaseHarness({ db, t3: first.t3 });
  await second.bridge.resume();
  pending.delete("run-2");
  await tickUntil(first.t3, () => second.ended.length === 1);
  assert.deepStrictEqual(second.ended, ["run-2"]);
  pending.delete("run-1");
  void first.t3.tick();
  await second.bridge.idle();
  assert.deepStrictEqual(second.ended, ["run-2", "run-1"]);
});

/**
 * `slack_start` binds a Slack thread to a T3 thread; then people answer there, as Slack sends
 * it through Office's relay. Every path is the real one but T3's and Slack's Web API.
 */
async function slackStartHarness(thread: { readonly root?: string } = {}): Promise<{
  readonly h: ReturnType<typeof subagentHarness>;
  readonly slack: Awaited<ReturnType<typeof relayedSlack>>;
  readonly api: Awaited<ReturnType<typeof fakeSlackApi>>;
  readonly start: (args: Record<string, unknown>) => Promise<string>;
  /** The tool's error, for a start that must fail. */
  readonly startError: (args: Record<string, unknown>) => Promise<string>;
  /** Slack's events for one human message, as Office relays them. */
  readonly say: (where: {
    channel: string;
    ts: string;
    threadTs: string;
    text: string;
  }) => Promise<void>;
  /** What T3 got: each message sent and to which thread, and any thread launched. */
  readonly t3Got: () => { sends: Array<[string, string]>; launches: number };
  readonly close: () => Promise<void>;
}> {
  let host: Awaited<ReturnType<typeof relayedSlack>>["host"] | undefined;
  const parts = harness(freshDatabase(), {
    directRoute: { projectId: PROJECT },
    routes: [{ channelId: "C0CHAN1", projectId: PROJECT }],
    allowEveryone: true,
    members: ["U0ADA"],
    slack: {
      startConversation: (channel, text, replyTo) => host!.startThread(channel, text, replyTo),
      bound: (chatThreadKey) => host!.follow(chatThreadKey),
    },
  });
  // The thread calling slack_start, such as an orchestrator's subagent, between runs.
  Object.assign(parts.t3.thread, {
    projectId: PROJECT,
    parentThreadId: "orchestrator",
    relationshipToParent: "subagent",
  });
  parts.t3.options.recentRuns = [{ runId: "child-0", ordinal: 1, status: "completed" }];
  parts.t3.finish("child-0", "completed", "Done.");
  // Each message starts a run, as one does after the last run ended; the test ends each.
  parts.t3.options.sendStartsRun = true;
  let runs = 0;
  const h = { ...parts, attach: async () => {} };
  const api = await fakeSlackApi({
    "users.info": (args) => ({ ok: true, user: { id: args.user, name: "ada", real_name: "Ada" } }),
    "chat.postMessage": (args) => {
      const channel = args.channel!.startsWith("U") ? "D0DMADA" : args.channel!;
      const ts = "1794300500.000100";
      // Slack posts a reply to a reply under the thread's root, and says so.
      const threadTs = args.thread_ts === undefined ? undefined : (thread.root ?? args.thread_ts);
      return {
        ok: true,
        channel,
        ts,
        message: { ts, ...(threadTs ? { thread_ts: threadTs } : {}) },
      };
    },
  });
  const slack = await relayedSlack(parts.bridge, parts.db, { apiUrl: api.apiUrl });
  host = slack.host;
  const platform = slackPlatform({
    host: () => host,
    access: { allowedUserIds: [], allowEveryone: true },
    channelRoutes: [{ channelId: "C0CHAN1", projectId: PROJECT }],
  });
  const deps = {
    bindingByChatKey: () => undefined,
    workspaceRoots: async () => [],
    post: async () => {},
    react: async () => undefined,
    setStatus: () => false,
    startSlack: (request: Parameters<typeof startSlackThread>[1]) =>
      startSlackThread(
        {
          access: {
            channelProjects: [{ channelId: "C0CHAN1" }],
            allowedUserIds: [],
            allowEveryone: true,
          },
          platform,
          core: parts.bridge,
        },
        request,
      ),
  };
  let rows = 0;
  const row = (event: Record<string, unknown>): SlackInboxRow => {
    rows += 1;
    return {
      id: `row-${rows}`,
      kind: "event",
      contentType: "application/json",
      retryNum: 0,
      rawBody: JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event_id: `Ev${rows}`,
        event: { team: "T1", user: "U0ADA", ...event },
      }),
    };
  };
  return {
    h,
    slack,
    api,
    start: async (args) => {
      const result = await callTool(deps, "slack_start", { threadId: "child-thread", ...args });
      assert.isUndefined(result.isError, JSON.stringify(result.content));
      return (result.content[0] as { text: string }).text;
    },
    startError: async (args) => {
      const result = await callTool(deps, "slack_start", { threadId: "child-thread", ...args });
      assert.isTrue(result.isError);
      return (result.content[0] as { text: string }).text;
    },
    say: async ({ channel, ts, threadTs, text }) => {
      const direct = channel.startsWith("D");
      const message = {
        channel,
        channel_type: direct ? "im" : "channel",
        ts,
        thread_ts: threadTs,
        text,
      };
      // A mention in a channel arrives twice, as Slack sends it: as a mention and as a message.
      const mentioned = !direct && text.includes("<@UBOT>");
      slack.push([
        ...(mentioned ? [row({ type: "app_mention", ...message })] : []),
        row({ type: "message", ...message }),
      ]);
      await slack.idle();
      const sent = parts.t3.calls.filter((call) => call.tool === "t3_thread_send").length;
      while (runs < sent) parts.t3.finish(`run-${++runs}`, "completed", "Done.");
      await parts.bridge.idle();
    },
    t3Got: () => ({
      sends: parts.t3.calls
        .filter((call) => call.tool === "t3_thread_send")
        .map((call) => [String(call.args.threadId), String(call.args.message)]),
      launches: parts.t3.calls.filter((call) => call.tool === "t3_thread_launch").length,
    }),
    close: async () => {
      await slack.close();
      await api.close();
    },
  };
}

it.each([
  [
    "a new channel message",
    { channel: "C0CHAN1", text: "Picking this up here." },
    "slack:C0CHAN1:1794300500.000100",
  ],
  [
    "a reply under an existing message",
    { channel: "C0CHAN1", text: "On it.", replyTo: "1794300400.000100" },
    "slack:C0CHAN1:1794300400.000100",
  ],
  ["a DM", { channel: "U0ADA", text: "Picking this up here." }, "slack:D0DMADA:1794300500.000100"],
] as const)(
  "continues the thread slack_start bound, from %s, when someone answers there with or without @Office",
  async (_name, args, key) => {
    const s = await slackStartHarness();
    try {
      assert.include(await s.start(args), key);
      assert.strictEqual(s.h.store.binding(key)?.threadId, "child-thread");
      const channel = key.split(":")[1]!;
      const threadTs = key.split(":")[2]!;
      await s.say({ channel, ts: "1794300601.000100", threadTs, text: "<@UBOT> do X" });
      await s.say({ channel, ts: "1794300602.000100", threadTs, text: "and Y" });
      await s.say({ channel, ts: "1794300603.000100", threadTs, text: "<@UBOT>" });
      const got = s.t3Got();
      assert.strictEqual(got.launches, 0, "no new T3 thread");
      assert.deepStrictEqual(
        got.sends.map(([threadId]) => threadId),
        ["child-thread", "child-thread", "child-thread"],
      );
      assert.include(got.sends[0]![1], "do X");
      assert.include(got.sends[1]![1], "and Y");
      assert.include(got.sends[2]![1], BOUND_BARE_MENTION_REQUEST);
      // Nothing else got bound: the one Slack thread still goes to the one T3 thread.
      assert.deepStrictEqual(
        s.h.store.bindingsForThread("child-thread").map((binding) => binding.chatThreadKey),
        [key],
      );
    } finally {
      await s.close();
    }
  },
);

it("binds the root when slack_start replies under a reply, so an @Office there continues the thread", async () => {
  const s = await slackStartHarness({ root: "1794300400.000100" });
  try {
    assert.include(
      await s.start({ channel: "C0CHAN1", text: "On it.", replyTo: "1794300407.000100" }),
      "slack:C0CHAN1:1794300400.000100",
    );
    await s.say({
      channel: "C0CHAN1",
      ts: "1794300601.000100",
      threadTs: "1794300400.000100",
      text: "<@UBOT> do X",
    });
    const got = s.t3Got();
    assert.strictEqual(got.launches, 0);
    assert.deepStrictEqual(
      got.sends.map(([threadId]) => threadId),
      ["child-thread"],
    );
  } finally {
    await s.close();
  }
});

it("won't take a Slack thread another T3 thread answers when slack_start replies under one of its replies", async () => {
  const s = await slackStartHarness({ root: "1794300400.000100" });
  try {
    const key = "slack:C0CHAN1:1794300400.000100";
    s.h.store.replaceBinding({
      chatThreadKey: key,
      channelId: "C0CHAN1",
      projectId: PROJECT,
      threadId: "other-thread",
      chatKey: "other-key",
      createdByUserId: "U0ADA",
    });
    assert.include(
      await s.startError({ channel: "C0CHAN1", text: "On it.", replyTo: "1794300407.000100" }),
      "already goes to thread other-thread",
    );
    assert.strictEqual(s.h.store.binding(key)?.threadId, "other-thread");
  } finally {
    await s.close();
  }
});
