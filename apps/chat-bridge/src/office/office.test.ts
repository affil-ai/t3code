// @effect-diagnostics nodeBuiltinImport:off -- Tests for a plain Node channel and expiring files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import { assert, expect, it, vi } from "vite-plus/test";

import { Bridge, type InboundEvent } from "../bridge.ts";
import { ACKNOWLEDGE_FIRST, type ChatPlatform, type OutboundMessage } from "../platform.ts";
import { BridgeStore, ensureSchema } from "../store.ts";
import { T3Threads, type RunStatus } from "../threads.ts";
import type { T3Tools } from "../t3Client.ts";
import { callTool } from "../toolServer.ts";
import { ArticleFiles } from "./article.ts";
import type {
  HistoryResult,
  InboxEvent,
  OfficeApi,
  OfficeMutations,
  PreparedRequest,
} from "./client.ts";
import { slackFirstTurnNote } from "../slack/platform.ts";
import type { ModelSelection } from "../modelCommand.ts";
import { officeModel } from "./message.ts";
import { createOfficeChannel } from "./platform.ts";

const request = (overrides: Partial<PreparedRequest> = {}): PreparedRequest => ({
  eventId: "event-1",
  chatId: "chat-1",
  chatUrl: "https://office.example/chat/chat-1",
  messageId: "message-1",
  author: { memberId: "member-1", name: "Ada <x>", email: "ADA@example.com" },
  text: "Fix the build",
  files: [],
  modeKey: "office",
  model: "anthropic/claude-opus-5.5",
  instructions: "Office root and mode instructions.",
  firstTurn: true,
  ...overrides,
});

function fakeOffice() {
  const requests = new Map<string, PreparedRequest>();
  const calls: Array<{ name: keyof OfficeMutations; args: Record<string, unknown> }> = [];
  const posts = new Map<string, OfficeMutations["post"]["args"]>();
  const fail = new Set<string>();
  const later = new Map<string, number>();
  const histories = new Map<string, HistoryResult>();
  const chatModels = new Map<string, ModelSelection>();
  let listener = (_events: InboxEvent[]) => {};
  let posted = (_post: OfficeMutations["post"]["args"]) => {};
  const api: OfficeApi = {
    history: async (chatId) => histories.get(chatId) ?? { kind: "ready", history: { recent: [] } },
    chatModel: async (chatId) => chatModels.get(chatId) ?? null,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = () => {};
      };
    },
    close: async () => {},
    mutate: async <K extends keyof OfficeMutations>(name: K, args: OfficeMutations[K]["args"]) => {
      calls.push({ name, args });
      if (fail.has(name)) throw new Error("Unavailable");
      let result: unknown;
      if (name === "prepare") {
        const eventId = (args as OfficeMutations["prepare"]["args"]).eventId;
        if (later.has(eventId))
          return {
            kind: "later",
            retryAfterMs: later.get(eventId),
          } as OfficeMutations[K]["result"];
        const prepared = requests.get(eventId);
        result =
          prepared === undefined
            ? { kind: "skip", reason: "revoked" }
            : { kind: "ready", request: prepared };
      } else if (name === "post") {
        const post = args as OfficeMutations["post"]["args"];
        if (!posts.has(post.eventId)) posts.set(post.eventId, post);
        posted(post);
      } else if (name === "uploadUrl") {
        result = { url: "https://storage.example/upload" };
      }
      return result as OfficeMutations[K]["result"];
    },
  };
  return {
    api,
    requests,
    calls,
    posts,
    fail,
    later,
    histories,
    chatModels,
    onPost: (next: typeof posted) => {
      posted = next;
    },
    emit: (events: InboxEvent[]) => listener(events),
    message: (prepared: PreparedRequest) => {
      requests.set(prepared.eventId, prepared);
      listener([
        {
          id: prepared.eventId,
          kind: "message",
          chatId: prepared.chatId,
          messageId: prepared.messageId,
          createdAt: 0,
        },
      ]);
    },
  };
}

function fakeT3() {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const runs = new Map<
    string,
    {
      status: RunStatus;
      answer?: string | undefined;
      done: Promise<void>;
      end: () => void;
    }
  >();
  const items: Array<Record<string, unknown>> = [];
  let nextRun = 0;
  let pulse = Promise.withResolvers<void>();
  let wake: string | undefined;
  const questions = new Map<string, Array<Record<string, unknown>>>();
  const failures = new Set<string>();
  /** The thread's model, as launches and `t3_thread_configure` set it. */
  const model: { current: unknown } = { current: undefined };
  // A tool held here waits, standing in for a process that stops partway through.
  const holds = new Map<string, Promise<void>>();
  const startRun = () => {
    const id = `run-${++nextRun}`;
    const { promise, resolve } = Promise.withResolvers<void>();
    runs.set(id, { status: "running", done: promise, end: resolve });
    return id;
  };
  const tools: T3Tools = {
    upload: async () => {},
    call: async <T>(tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      await holds.get(tool);
      if (failures.has(tool)) throw new Error("T3 unavailable");
      let result: unknown;
      if (tool === "t3_thread_launch") {
        result = { threadId: "thread-1", runId: startRun() };
        if (args.modelSelection !== undefined) model.current = args.modelSelection;
      } else if (tool === "t3_thread_configure") {
        if (args.modelSelection !== undefined) model.current = args.modelSelection;
        result = { threadId: args.threadId, modelSelection: model.current };
      } else if (tool === "t3_thread_send" || tool === "t3_thread_send_attachments") {
        result = { runId: startRun(), delivery: "started" };
      } else if (tool === "t3_thread_wait") {
        const runId = String(args.runId);
        const run = runs.get(runId)!;
        let timedOut = false;
        if (args.untilDelegatedWorkSettled === true && wake !== undefined) {
          const wakeId = startRun();
          const next = runs.get(wakeId)!;
          next.status = "completed";
          next.answer = wake;
          next.end();
          items.push({
            position: 100,
            itemId: "wake",
            type: "notification",
            runId: wakeId,
            status: "completed",
            text: "Work finished",
          });
          wake = undefined;
        } else if (args.untilDelegatedWorkSettled !== true && args.timeoutMs !== 0) {
          timedOut = await Promise.race([
            run.done.then(() => false),
            pulse.promise.then(() => true),
          ]);
        }
        result = { runId, status: run.status, timedOut };
      } else if (tool === "t3_thread_interrupt") {
        for (const run of runs.values()) {
          run.status = "interrupted";
          run.end();
        }
      } else if (tool === "t3_thread_read") {
        const answers = [...runs]
          .filter(([, run]) => run.answer !== undefined)
          .map(([runId, run], index) => ({
            position: index + items.length + 1,
            itemId: `answer-${runId}`,
            type: "assistant_message",
            runId,
            status: "completed",
            text: run.answer,
          }));
        const all = [...items, ...answers];
        result = {
          thread: {
            projectId: "project-1",
            title: "Build fixes",
            pendingRequestCount: 0,
            itemCount: all.length,
          },
          items: args.itemId ? all.filter((item) => item.itemId === args.itemId) : all,
          hasMore: false,
          nextPosition: null,
          recentRuns: [{ runId: "legacy-run", ordinal: 1, status: "completed" }],
        };
      } else if (tool === "t3_pending_request") {
        if (args.action === "list") result = { requestIds: [...questions.keys()] };
        else if (args.action === "read")
          result = { questions: questions.get(String(args.requestId)) };
        else questions.delete(String(args.requestId));
      } else if (tool === "t3_attachment_prepare_upload")
        result = { attachmentId: "file-1", relativeUrl: "/upload" };
      return result as T;
    },
  };
  return {
    tools,
    calls,
    model,
    runs,
    failures,
    holds,
    items,
    questions,
    tick: () => {
      pulse.resolve();
      pulse = Promise.withResolvers<void>();
    },
    wake: (answer: string) => {
      wake = answer;
    },
    finish: (runId: string, answer: string) => {
      const run = runs.get(runId)!;
      run.answer = answer;
      run.status = "completed";
      run.end();
    },
  };
}

async function harness(
  options: {
    office?: ReturnType<typeof fakeOffice>;
    t3?: ReturnType<typeof fakeT3>;
    db?: NodeSqlite.DatabaseSync;
    home?: string;
    slack?: ChatPlatform;
    now?: () => number;
    /** As the bridge's config gives it: the model new threads start on. */
    defaultModel?: ModelSelection;
    /** As the bridge's config gives it: defaults used before `defaultModel`. */
    formerModels?: ReadonlyArray<ModelSelection>;
    /** The model T3 reports for threads, when it isn't `defaultModel`. */
    threadModel?: ModelSelection;
  } = {},
) {
  const home =
    options.home ?? (await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "office-channel-")));
  // A fixture CLI package lets the article launcher resolve its normal, content-owned executable.
  const fixture = NodePath.join(home, "apps/office/node_modules/tsx");
  await NodeFSP.mkdir(fixture, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(fixture, "package.json"),
    JSON.stringify({ name: "tsx", exports: { "./cli": "./cli.mjs" } }),
  );
  await NodeFSP.writeFile(NodePath.join(fixture, "cli.mjs"), "");
  await NodeFSP.mkdir(NodePath.join(home, "apps/office/scripts"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(home, "apps/office/scripts/article-workspace.cts"), "");
  const db = options.db ?? new NodeSqlite.DatabaseSync(":memory:");
  ensureSchema(db);
  const store = new BridgeStore(db);
  const office = options.office ?? fakeOffice();
  const t3 = options.t3 ?? fakeT3();
  const logs: string[] = [];
  const uploads: Array<{ url: string; body: unknown }> = [];
  const channel = createOfficeChannel({
    api: office.api,
    store,
    home,
    repositoryPath: home,
    route: { projectId: "project-1", worktreeFrom: "dev" },
    slack: options.slack,
    now: () => 0,
    log: (line) => {
      logs.push(line);
    },
    fetch: async (url, init) => {
      uploads.push({ url: String(url), body: init?.body });
      return init?.method === "POST"
        ? Response.json({ storageId: "storage-1" })
        : new Response("incoming file");
    },
  });
  const bridge = new Bridge({
    store,
    threads: new T3Threads(t3.tools, {
      modelSelection: options.threadModel ??
        options.defaultModel ?? { instanceId: "codex", model: "default-model" },
    }),
    settings: {
      ...(options.defaultModel ? { modelSelection: options.defaultModel } : {}),
      ...(options.formerModels ? { formerModelSelections: options.formerModels } : {}),
    },
    platforms: [channel.platform, ...(options.slack ? [options.slack] : [])],
    seedHistory: channel.seedHistory,
    chatModel: channel.chatModel,
    now: options.now ?? (() => 0),
    log: (line) => {
      logs.push(line);
    },
    // Yields, so a retry loop waiting on Office never starves the test.
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
    sleep: () => NodeTimersPromises.setImmediate(),
    schedule: () => {},
  });
  await channel.start(bridge);
  return {
    home,
    db,
    store,
    office,
    t3,
    logs,
    uploads,
    channel,
    bridge,
    send: async (prepared = request()) => {
      office.message(prepared);
      await channel.idle();
    },
    async [Symbol.asyncDispose]() {
      bridge.stop();
      for (const run of t3.runs.values()) run.end();
      await bridge.idle();
      await channel.close();
      if (!options.db) db.close();
      if (!options.home) await NodeFSP.rm(home, { recursive: true, force: true });
    },
  };
}

it("starts and follows an Office chat through the core, preserves attribution, and sends steps and plans", async () => {
  await using h = await harness();
  await h.send(
    request({
      files: [
        {
          attachmentId: "incoming",
          filename: "note.txt",
          mimeType: "text/plain",
          byteSize: 13,
          url: "https://storage.example/input",
        },
      ],
    }),
  );
  const launch = h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args;
  assert.include(String(launch.message), "Office root and mode instructions.");
  assert.include(String(launch.message), "Co-authored-by: Ada x <ada@example.com>");
  assert.notInclude(String(launch.message), "office-slack-routing");
  // The first turn asks the agent to acknowledge in its own words before long work.
  assert.include(String(launch.message), ACKNOWLEDGE_FIRST);
  assert.deepEqual(launch.modelSelection, {
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "medium" }],
  });
  assert.lengthOf(launch.attachments as unknown[], 1);
  h.t3.items.push(
    {
      position: 0,
      itemId: "step-1",
      type: "command_execution",
      runId: "run-1",
      status: "completed",
      text: "$ pnpm test\nok",
    },
    {
      position: 1,
      itemId: "plan-1",
      type: "todo_list",
      runId: "run-1",
      status: "completed",
      text: "[completed] Fix",
    },
  );
  h.t3.finish("run-1", "Fixed.");
  await h.bridge.idle();
  assert.equal(h.office.posts.get("answer:thread-1:run-1")?.text, "Fixed.");
  assert.isTrue(
    h.office.calls.some((call) => call.name === "step" && call.args.itemId === "step-1"),
  );
  assert.isTrue(h.office.calls.some((call) => call.name === "plan"));
  assert.deepInclude(h.office.calls, {
    name: "state",
    args: { chatId: "chat-1", state: "active", text: "", outcome: "completed" },
  });
  await h.send(
    request({
      eventId: "event-2",
      messageId: "message-2",
      text: "Also fix lint",
      firstTurn: false,
    }),
  );
  const follow = h.t3.calls.find((call) => call.tool === "t3_thread_send")!.args;
  assert.include(String(follow.message), "Also fix lint");
  assert.notInclude(String(follow.message), "Office root and mode instructions.");
  assert.notInclude(String(follow.message), ACKNOWLEDGE_FIRST);
  h.t3.finish("run-2", "Fixed.");
  await h.bridge.idle();
  assert.equal(h.office.posts.size, 2, "equal text from different runs is not deduped");
});

it("stops through the core and does not repeat a stop whose ack was lost", async () => {
  await using h = await harness();
  await h.send();
  h.office.fail.add("ack");
  const stop: InboxEvent = {
    id: "stop-1",
    kind: "stop",
    chatId: "chat-1",
    memberId: "member-1",
    createdAt: 1,
  };
  h.office.emit([stop]);
  await h.channel.idle();
  await h.bridge.idle();
  assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_interrupt").length, 1);
  assert.isTrue(h.store.isHandled("office:stop-1"));
  assert.include([...h.office.posts.values()][0]!.text, "stopped");
  assert.deepInclude(h.office.calls, {
    name: "state",
    args: { chatId: "chat-1", state: "active", text: "", outcome: "canceled" },
  });
  await h.channel.close();
  h.office.fail.clear();
  await using restarted = await harness({ office: h.office, t3: h.t3, db: h.db, home: h.home });
  h.office.emit([stop]);
  await restarted.channel.idle();
  assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_interrupt").length, 1);
});

it("NO_REPLY ends the Office state without posting", async () => {
  await using h = await harness();
  await h.send();
  h.t3.finish("run-1", "NO_REPLY");
  await h.bridge.idle();
  assert.equal(h.office.posts.size, 0);
  assert.deepInclude(h.office.calls, {
    name: "state",
    args: { chatId: "chat-1", state: "active", text: "", outcome: "completed" },
  });
});

it("tells Office how each turn ended when it sets the chat active", async () => {
  await using h = await harness();
  await h.send();
  const failed = h.t3.runs.get("run-1")!;
  failed.status = "failed";
  failed.end();
  await h.bridge.idle();
  await h.send(
    request({ eventId: "event-2", messageId: "message-2", text: "Try again", firstTurn: false }),
  );
  h.t3.finish("run-2", "Fixed.");
  await h.bridge.idle();
  await h.send(
    request({ eventId: "event-3", messageId: "message-3", text: "And docs", firstTurn: false }),
  );
  // Stopped from the T3 UI, not from Office.
  const interrupted = h.t3.runs.get("run-3")!;
  interrupted.status = "interrupted";
  interrupted.end();
  await h.bridge.idle();
  assert.deepEqual(
    h.office.calls
      .filter((call) => call.name === "state" && call.args.state === "active")
      .map((call) => call.args.outcome),
    ["failed", "completed", "canceled"],
  );
  assert.isTrue(
    h.office.calls
      .filter((call) => call.name === "state" && call.args.state !== "active")
      .every((call) => !("outcome" in call.args)),
  );
});

it("uploads chat_post files with a stable invocation identity, independent of their text", async () => {
  await using h = await harness();
  await h.send();
  const binding = h.store.binding("office:chat-1")!;
  const file = NodePath.join(h.home, "result.txt");
  await NodeFSP.writeFile(file, "report");
  const deps = {
    bindingByChatKey: (key: string) => h.store.bindingByChatKey(key),
    workspaceRoots: async () => [h.home],
    post: h.channel.platform.post,
    react: async () => undefined,
    setStatus: () => false,
  };
  const args = { chatKey: binding.chatKey, kind: "done", text: "Report", files: [{ path: file }] };
  assert.isUndefined((await callTool(deps, "chat_post", args, "invocation-1")).isError);
  await callTool(deps, "chat_post", args, "invocation-1");
  assert.equal(h.office.posts.size, 1);
  assert.deepEqual(h.office.posts.get("tool:thread-1:invocation-1")?.files, [
    { storageId: "storage-1", filename: "result.txt", mimeType: "text/plain" },
  ]);
  assert.equal(Buffer.from(h.uploads[0]!.body as Uint8Array).toString(), "report");
  await callTool(deps, "chat_post", args, "invocation-2");
  assert.equal(h.office.posts.size, 2);
});

it("stages private article credentials outside prompts and SQLite, and removes them on completion", async () => {
  await using h = await harness();
  const token = "fixture-article-capability-do-not-log";
  const article = {
    convexUrl: "https://example.convex.cloud",
    token,
    runId: "article-1",
    expiresAt: 60_000,
    instructions: "Stage only the requested change.",
    targetId: "target-1",
    snapshot: { document: "current" },
  };
  // Keep the safe event in SQLite while the first handoff fails.
  h.t3.failures.add("t3_thread_launch");
  await h.send(request({ article }));
  const connection = NodePath.join(h.home, "office-article/chat-1/article-1.json");
  assert.equal((await NodeFSP.stat(connection)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await NodeFSP.readFile(connection, "utf8")).token, token);
  assert.notInclude(h.store.inboxHead("office:chat-1")!.event, token);
  assert.notInclude(JSON.stringify(h.t3.calls), token);
  assert.notInclude(h.logs.join("\n"), token);
  // The agent gets the launcher, never the path of the file that holds the token.
  const prompt = String(h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.message);
  assert.include(prompt, NodePath.join(h.home, "office-article/chat-1/article-1.sh"));
  assert.notInclude(prompt, connection);
  h.t3.failures.clear();
  h.store.retryLater("office:event-1", 1, 0, "");
  await h.bridge.resume();
  h.t3.finish("run-1", "Staged.");
  await h.bridge.idle();
  await expect(NodeFSP.stat(connection)).rejects.toThrow(/ENOENT/);
});

it("expires restored article credentials without a running thread", async () => {
  await using h = await harness();
  vi.useFakeTimers();
  try {
    const articles = new ArticleFiles(
      h.home,
      h.home,
      () => {},
      () => 0,
    );
    const path = NodePath.join(h.home, "office-article/chat-1/article-2.json");
    await NodeFSP.mkdir(NodePath.join(h.home, "office-article/chat-1"), { recursive: true });
    await NodeFSP.writeFile(
      path,
      JSON.stringify({ token: "fixture-only", expiresAt: 1000, bridgeRunId: "run-1" }),
      { mode: 0o600 },
    );
    await articles.restore();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(NodeFSP.stat(path)).rejects.toThrow(/ENOENT/);
    await articles.close();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a concurrent article run's connection when the earlier run ends", async () => {
  await using h = await harness();
  const article = {
    convexUrl: "https://example.convex.cloud",
    token: "fixture-only",
    runId: "article-1",
    expiresAt: 60_000,
    instructions: "",
  };
  await h.send(request({ article }));
  await h.send(
    request({
      eventId: "event-2",
      messageId: "message-2",
      article: { ...article, runId: "article-2" },
    }),
  );
  const firstAnswered = Promise.withResolvers<void>();
  h.office.onPost((post) => {
    if (post.eventId === "answer:thread-1:run-1") firstAnswered.resolve();
  });
  h.t3.finish("run-1", "First done");
  await firstAnswered.promise;
  // Removed once the run's delegated work settles, a moment after its answer.
  await vi.waitFor(() =>
    expect(
      NodeFSP.stat(NodePath.join(h.home, "office-article/chat-1/article-1.json")),
    ).rejects.toThrow(/ENOENT/),
  );
  assert.equal(
    (await NodeFSP.stat(NodePath.join(h.home, "office-article/chat-1/article-2.json"))).mode &
      0o777,
    0o600,
  );
  h.t3.finish("run-2", "Second done");
  await h.bridge.idle();
  await expect(
    NodeFSP.stat(NodePath.join(h.home, "office-article/chat-1/article-2.json")),
  ).rejects.toThrow(/ENOENT/);
});

it("acks after a restart when every ack failed, then answers without starting again", async () => {
  await using h = await harness();
  h.office.fail.add("ack");
  h.office.message(request());
  await vi.waitFor(() => assert.isTrue(h.store.isHandled("office:event-1")));
  h.t3.finish("run-1", "Done.");
  await vi.waitFor(() => assert.isTrue(h.office.calls.filter((c) => c.name === "ack").length >= 3));
  assert.equal(h.office.posts.size, 0, "the answer waits for the ack");
  h.bridge.stop();
  await h.channel.close();
  h.office.fail.clear();
  await using restarted = await harness({ office: h.office, t3: h.t3, db: h.db, home: h.home });
  await restarted.bridge.resume();
  await restarted.send();
  await restarted.bridge.idle();
  assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_launch").length, 1);
  assert.equal(h.office.posts.size, 1);
  const names = h.office.calls.map((call) => call.name);
  assert.isBelow(
    names.lastIndexOf("ack"),
    names.indexOf("post"),
    "Office hears of the request first",
  );
});

/** Stops the launch at its title request, after the launch is saved, until released. */
function holdTitle(t3: ReturnType<typeof fakeT3>) {
  const held = Promise.withResolvers<void>();
  t3.holds.set("t3_thread_update", held.promise);
  return {
    [Symbol.dispose]: () => {
      t3.holds.delete("t3_thread_update");
      held.resolve();
    },
  };
}

it("tells Office a request reached its run before a restart reports the run's end", async () => {
  await using h = await harness();
  using _held = holdTitle(h.t3);
  h.office.message(request());
  await vi.waitFor(() => assert.isTrue(h.store.isHandled("office:event-1")));
  assert.isFalse(h.office.calls.some((call) => call.name === "ack"));
  // The process stops here, before acking; the run ends while it is down.
  h.bridge.stop();
  h.t3.finish("run-1", "Done.");
  const before = h.office.calls.length;
  await using restarted = await harness({ office: h.office, t3: h.t3, db: h.db, home: h.home });
  await restarted.bridge.resume();
  await restarted.bridge.idle();
  const after = h.office.calls.slice(before);
  const acked = after.findIndex(
    (call) =>
      call.name === "ack" && call.args.eventId === "event-1" && call.args.result === "stored",
  );
  const ended = after.findIndex((call) => call.name === "state" && call.args.state === "active");
  assert.isAtLeast(acked, 0, "the ack the crash lost is sent");
  assert.isAbove(ended, acked, "Office hears of the request before the turn ends");
  assert.equal(h.office.posts.get("answer:thread-1:run-1")?.text, "Done.");
  assert.isEmpty(h.store.owedDispatches());
});

it("doesn't end an Office turn when the bridge stops mid-run, and reports it after the restart", async () => {
  await using h = await harness();
  await h.send();
  const active = () =>
    h.office.calls.filter((call) => call.name === "state" && call.args.state === "active");
  h.bridge.stop();
  // The run ends while the bridge is stopping: its watcher wakes, but must not end the turn.
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  assert.isEmpty(active(), "a stopping bridge leaves the turn to the next start");
  await using restarted = await harness({ office: h.office, t3: h.t3, db: h.db, home: h.home });
  await restarted.bridge.resume();
  await restarted.bridge.idle();
  assert.deepEqual(
    active().map((call) => call.args.outcome),
    ["completed"],
  );
  assert.equal(h.office.posts.get("answer:thread-1:run-1")?.text, "Done.");
});

it("keeps an Office request's answer and end waiting until a failed ack goes through, past the post retries", async () => {
  await using h = await harness();
  const mutate = h.office.api.mutate;
  // More failures than MAX_POST_ATTEMPTS: the ack is never dropped.
  let ackFailures = 7;
  const acked: boolean[] = [];
  h.office.api.mutate = async (name, args) => {
    if (name === "ack") {
      acked.push(ackFailures <= 0);
      if (ackFailures-- > 0) throw new Error("Unavailable");
    }
    return mutate(name, args);
  };
  let answeredAfterAck: boolean | undefined;
  h.office.onPost(() => {
    answeredAfterAck = acked.includes(true);
  });
  h.office.message(request());
  await vi.waitFor(() => assert.isNotEmpty(acked));
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  await h.channel.idle();
  assert.isTrue(answeredAfterAck, "the answer waits for the ack");
  assert.deepEqual(acked, [false, false, false, false, false, false, false, true]);
  const calls = h.office.calls.map((call) => `${call.name}:${String(call.args.state ?? "")}`);
  assert.isBelow(
    calls.indexOf("ack:"),
    calls.indexOf("state:active"),
    "Office hears of the request first",
  );
  assert.equal(h.office.posts.get("answer:thread-1:run-1")?.text, "Done.");
  assert.isEmpty(h.store.owedDispatches());
});

it.each(["seeded", "linked"])(
  "answers a %s synced Slack conversation when a restart interrupts the launch",
  async (kind) => {
    const posts: OutboundMessage[] = [];
    const slack: ChatPlatform = {
      id: "slack",
      name: "Slack",
      place: "Slack thread",
      access: { allowedUserIds: ["staff"] },
      channelRoutes: [{ channelId: "C1", projectId: "project-1" }],
      person: (_id, name) => name,
      firstTurnNote: () => "",
      refusal: () => "",
      startConversation: async () => "slack:C1:1.1",
      post: async (message) => {
        posts.push(message);
      },
    };
    await using h = await harness({ slack });
    using _held = holdTitle(h.t3);
    if (kind === "seeded") {
      for (const key of ["office:chat-1", "slack:C1:1.1"])
        h.store.insertSeed({
          chatThreadKey: key,
          channelId: key.startsWith("office") ? "chat-1" : "C1",
          chatId: "chat-1",
          oldThreadId: "old",
          sync: true,
        });
    }
    h.office.message(
      kind === "seeded"
        ? request({ history: { summary: "Old conversation", recent: [] } })
        : request({ slack: { channelId: "C1", chatThreadKey: "slack:C1:1.1" }, sync: true }),
    );
    await vi.waitFor(() => assert.isTrue(h.store.isHandled("office:event-1")));
    h.bridge.stop();
    h.t3.finish("run-1", "Done.");
    await using restarted = await harness({
      slack,
      office: h.office,
      t3: h.t3,
      db: h.db,
      home: h.home,
    });
    await restarted.bridge.resume();
    await restarted.bridge.idle();
    assert.equal(h.store.binding("slack:C1:1.1")?.threadId, "thread-1");
    assert.equal(h.office.posts.get("answer:thread-1:run-1")?.text, "Done.");
    assert.deepEqual(
      posts.filter((post) => post.kind === "answer").map((post) => post.text),
      ["Done."],
    );
  },
);

it("starts a new thread with Office history even when the old thread is readable", async () => {
  for (const readable of [true, false]) {
    await using h = await harness();
    if (!readable) h.t3.failures.add("t3_thread_read");
    if (readable)
      h.store.insertBinding({
        chatThreadKey: "office:older-chat",
        channelId: "older-chat",
        projectId: "project-1",
        threadId: "legacy-thread",
        chatKey: "older-key",
        createdByUserId: "member-1",
      });
    await h.send(
      request({
        history: {
          summary: "We chose the smaller fix.",
          recent: [{ role: "user", author: "Ada", text: "Keep the existing API.", at: 1 }],
          oldThreadId: "legacy-thread",
        },
      }),
    );
    assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_launch").length, 1);
    assert.equal(h.store.binding("office:chat-1")!.threadId, "thread-1");
    assert.isFalse(h.store.isOwed("legacy-run"));
    if (readable) assert.lengthOf(h.store.bindingsForThread("legacy-thread"), 1);
    const launch = h.t3.calls.find((call) => call.tool === "t3_thread_launch")!;
    assert.include(String(launch.args.message), "We chose the smaller fix.");
    assert.include(String(launch.args.message), "Keep the existing API.");
    assert.include(String(launch.args.message), "legacy-thread");
    assert.equal(h.office.posts.size, 0);
    h.t3.failures.clear();
    h.t3.finish("run-1", "New answer");
    await h.bridge.idle();
    assert.equal(h.office.posts.size, 1);
  }
  assert.isUndefined(officeModel("unknown/provider"));
  await using h = await harness();
  await h.send(request({ model: "unknown/provider" }));
  assert.deepEqual(
    h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.modelSelection,
    { instanceId: "codex", model: "default-model" },
  );
});

it("rejects revoked requests without handing them to T3", async () => {
  await using h = await harness();
  h.office.emit([
    { id: "revoked", kind: "message", chatId: "chat-1", messageId: "message-1", createdAt: 0 },
  ]);
  await h.channel.idle();
  assert.isFalse(h.t3.calls.some((call) => call.tool === "t3_thread_launch"));
  assert.equal(h.office.calls.at(-1)?.args.result, "rejected");
});

it.each([
  { producer: "support", sync: false },
  { producer: "support", sync: true },
  { producer: "mockup", sync: true },
  { producer: "schedule", sync: true },
])(
  "links $producer conversations with sync $sync, preserving origin routing and staff follow-ups",
  async ({ producer, sync }) => {
    const posts: OutboundMessage[] = [];
    const steps: string[] = [];
    const roots: string[] = [];
    const states: string[] = [];
    const plans: unknown[] = [];
    const slack: ChatPlatform = {
      id: "slack",
      name: "Slack",
      place: "Slack thread",
      access: { allowedUserIds: ["staff-1"] },
      person: (id) => `<@${id}>`,
      firstTurnNote: () => "Reply to Slack.",
      refusal: () => "Not allowed",
      post: async (message) => {
        posts.push(message);
      },
      step: async (_key, step) => {
        steps.push(step.itemId);
      },
      setState: async (_key, state) => {
        states.push(state);
      },
      plan: async (_key, plan) => {
        plans.push(plan);
      },
      startConversation: async (channel, text) => {
        roots.push(`${channel}:${text}`);
        return `slack:${channel}:123.456`;
      },
    };
    await using h = await harness({ slack });
    const support = request({
      modeKey: producer,
      sync,
      slack: { channelId: "C-SUPPORT", rootText: "New case" },
    });
    await h.send(support);
    assert.deepEqual(roots, ["C-SUPPORT:New case"]);
    assert.deepInclude(h.office.calls, {
      name: "linkSlack",
      args: { eventId: "event-1", chatThreadKey: "slack:C-SUPPORT:123.456" },
    });
    assert.isDefined(h.store.binding("slack:C-SUPPORT:123.456"));
    assert.equal(
      h.store.binding("slack:C-SUPPORT:123.456")?.threadId,
      h.store.binding("office:chat-1")?.threadId,
    );
    assert.equal(h.store.synced("thread-1"), sync);
    h.t3.items.push({
      position: 0,
      itemId: "support-step",
      type: "command_execution",
      runId: "run-1",
      status: "completed",
      text: "$ inspect\nok",
    });
    h.t3.items.push({
      position: 1,
      itemId: "support-plan",
      type: "todo_list",
      runId: "run-1",
      status: "completed",
      text: "[completed] Help customer",
    });
    h.t3.finish("run-1", "Support answer");
    await h.bridge.idle();
    assert.equal(posts.filter((post) => post.kind === "answer").length, sync ? 1 : 0);
    assert.equal(steps.includes("support-step"), sync);
    assert.equal(states.includes("processing"), sync);
    assert.equal(plans.length, sync ? 1 : 0);
    assert.equal(h.office.posts.size, 1);
    const staff: InboundEvent = {
      eventId: "slack:staff-message",
      chatThreadKey: "slack:C-SUPPORT:123.456",
      channelId: "C-SUPPORT",
      messageId: "staff-message",
      kind: "follow_up",
      direct: false,
      addressed: true,
      author: { userId: "staff-1", userName: "Staff", fullName: "Staff" },
      text: "Follow up with the customer",
      files: [],
      mentions: [],
    };
    await h.bridge.receive(staff);
    h.t3.finish("run-2", "Followed up");
    await h.bridge.idle();
    assert.equal(posts.filter((post) => post.kind === "answer").length, sync ? 2 : 1);
    assert.equal(h.office.posts.size, sync ? 3 : 1);
    if (sync)
      assert.isTrue(
        [...h.office.posts.values()].some(
          (post) =>
            post.kind === "update" && post.text === "Staff (in Slack): Follow up with the customer",
        ),
      );
    await h.send(
      request({
        eventId: "event-3",
        sync,
        slack: { channelId: "C-SUPPORT", chatThreadKey: "slack:C-SUPPORT:123.456" },
      }),
    );
    h.t3.finish("run-3", "Email handled");
    await h.bridge.idle();
    assert.lengthOf(roots, 1);
    assert.equal(posts.filter((post) => post.kind === "answer").length, sync ? 3 : 1);
    assert.equal(h.office.posts.size, sync ? 4 : 2);
    assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_launch").length, 1);
    await h.bridge.postFromAgent({
      eventId: "tool-update",
      chatThreadKey: "office:chat-1",
      text: "Tool update",
      kind: "update",
    });
    assert.equal(h.office.posts.get("tool-update")?.text, "Tool update");
    assert.equal(
      posts.some((post) => post.eventId === "tool-update"),
      sync,
    );
  },
);

it("resumes an Office compaction wait after restart without acking early or launching twice", async () => {
  let now = 0;
  await using h = await harness({ now: () => now });
  h.office.later.set("event-1", 100);
  await h.send(request({ history: { summary: "Before cutover", recent: [], oldThreadId: "old" } }));
  assert.equal(h.store.inboxHead("office:chat-1")?.retryAt, 100);
  assert.equal(h.store.inboxHead("office:chat-1")?.attempts, 0);
  assert.isFalse(h.office.calls.some((call) => call.name === "ack"));
  assert.isFalse(h.t3.calls.some((call) => call.tool === "t3_thread_launch"));
  assert.deepInclude(h.office.calls, { name: "requestCompaction", args: { chatId: "chat-1" } });
  await h.send(h.office.requests.get("event-1")!);
  assert.isFalse(h.office.calls.some((call) => call.name === "ack"));
  h.bridge.stop();
  await h.channel.close();
  await using restarted = await harness({
    office: h.office,
    t3: h.t3,
    db: h.db,
    home: h.home,
    now: () => now,
  });
  await restarted.bridge.resume();
  assert.isFalse(h.t3.calls.some((call) => call.tool === "t3_thread_launch"));
  now = 100;
  h.office.later.clear();
  await restarted.bridge.resume();
  await restarted.send(h.office.requests.get("event-1")!);
  assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_launch").length, 1);
  assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_send").length, 0);
  assert.isUndefined(h.store.inboxHead("office:chat-1"));
  assert.isTrue(h.store.isHandled("office:event-1"));
  assert.include(
    String(h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.message),
    "Before cutover",
  );
  assert.deepInclude(h.office.calls, {
    name: "ack",
    args: { eventId: "event-1", result: "stored" },
  });
});

it("serializes simultaneous first messages on a seeded Office and Slack pair", async () => {
  const slack: ChatPlatform = {
    id: "slack",
    name: "Slack",
    place: "Slack thread",
    access: { allowedUserIds: ["staff"] },
    channelRoutes: [{ channelId: "C1", projectId: "project-1" }],
    person: (_id, name) => name,
    firstTurnNote: () => "",
    refusal: () => "",
    post: async () => {},
  };
  await using h = await harness({ slack });
  for (const key of ["office:chat-1", "slack:C1:1.1"])
    h.store.insertSeed({
      chatThreadKey: key,
      channelId: key.startsWith("office") ? "chat-1" : "C1",
      chatId: "chat-1",
      oldThreadId: "old",
      sync: true,
    });
  await Promise.all([
    h.send(request({ history: { summary: "Old conversation", recent: [] } })),
    h.bridge.receive({
      eventId: "slack:C1:2.1",
      chatThreadKey: "slack:C1:1.1",
      channelId: "C1",
      messageId: "2.1",
      kind: "follow_up",
      addressed: false,
      direct: false,
      author: { userId: "staff", userName: "Ada", fullName: "Ada" },
      text: "Also fix the tests",
      files: [],
      mentions: [],
    }),
  ]);
  assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_launch").length, 1);
  assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_send").length, 1);
  assert.equal(
    h.store.binding("office:chat-1")?.threadId,
    h.store.binding("slack:C1:1.1")?.threadId,
  );
  assert.isEmpty(h.store.seeds("chat-1"));
});

it.each(["support", "mockup", "slack", "schedule"])(
  "seeds a %s group from an unmentioned Slack reply and resumes its history wait",
  async (kind) => {
    const sync = kind === "support" || kind === "mockup";
    const posts: OutboundMessage[] = [];
    const slack: ChatPlatform = {
      id: "slack",
      name: "Slack",
      place: "Slack thread",
      access: { allowedUserIds: ["staff"] },
      channelRoutes: [{ channelId: "C1", projectId: "project-1" }],
      person: (_id, name) => name,
      firstTurnNote: () => "Reply here",
      refusal: () => "Not allowed",
      post: async (message) => {
        posts.push(message);
      },
      history: async () => {
        throw new Error("Seeded chats must use Office history");
      },
    };
    let now = 0;
    await using h = await harness({ slack, now: () => now });
    const keys = sync ? ["office:chat-1", "slack:C1:1.1"] : ["slack:C1:1.1"];
    for (const chatThreadKey of keys)
      h.store.insertSeed({
        chatThreadKey,
        channelId: chatThreadKey.startsWith("slack") ? "C1" : "chat-1",
        chatId: "chat-1",
        oldThreadId: "old-thread",
        sync,
      });
    const event: InboundEvent = {
      eventId: "slack:C1:2.1",
      chatThreadKey: "slack:C1:1.1",
      channelId: "C1",
      messageId: "2.1",
      kind: "follow_up",
      addressed: false,
      direct: false,
      author: { userId: "staff", userName: "Ada", fullName: "Ada" },
      text: "Continue the fix",
      files: [],
      mentions: [],
    };
    h.office.histories.set("chat-1", { kind: "later", retryAfterMs: 100 });
    assert.equal((await h.bridge.receive(event)).type, "pending");
    assert.equal(h.store.inboxHead(event.chatThreadKey)?.retryAt, 100);
    assert.equal(h.store.inboxHead(event.chatThreadKey)?.attempts, 0);
    assert.isDefined(h.store.seed(event.chatThreadKey));
    if (sync) {
      await h.send(request({ history: { summary: "Office is already ready", recent: [] } }));
      assert.isFalse(h.t3.calls.some((call) => call.tool === "t3_thread_launch"));
    }
    h.bridge.stop();
    await h.channel.close();
    await using restarted = await harness({
      slack,
      office: h.office,
      t3: h.t3,
      db: h.db,
      home: h.home,
      now: () => now,
    });
    await restarted.bridge.resume();
    assert.isFalse(h.t3.calls.some((call) => call.tool === "t3_thread_launch"));
    h.office.histories.set("chat-1", {
      kind: "ready",
      history: {
        summary: "Checkpoint summary",
        recent: [{ role: "assistant", text: "Next step", at: 1 }],
      },
    });
    now = 100;
    await restarted.bridge.resume();
    assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_launch").length, 1);
    const text = String(h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.message);
    for (const expected of [
      "Checkpoint summary",
      "Next step",
      "old-thread",
      "t3_thread_read only if needed",
    ])
      assert.include(text, expected);
    assert.isEmpty(h.store.seeds("chat-1"));
    for (const key of keys) assert.equal(h.store.binding(key)?.threadId, "thread-1");
    assert.equal(h.store.synced("thread-1"), sync);
    assert.equal(h.office.posts.size, sync ? 1 : 0);
    await restarted.bridge.receive(event);
    assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_launch").length, 1);
  },
);

it("relays feedback with files without binding it, while an existing Slack binding wins", async () => {
  const posts: OutboundMessage[] = [];
  let lookups = 0;
  const slack: ChatPlatform = {
    id: "slack",
    name: "Slack",
    place: "Slack thread",
    access: { allowedUserIds: ["staff"] },
    person: (_id, name) => name,
    firstTurnNote: () => "",
    refusal: () => "Not allowed",
    post: async (message) => {
      posts.push(message);
    },
    feedbackTarget: async () => {
      lookups++;
      return { threadId: "agent-thread", note: "Reply through Executor" };
    },
    download: async () => new TextEncoder().encode("Attached content"),
  };
  await using h = await harness({ slack });
  const event: InboundEvent = {
    eventId: "slack:C1:2.1",
    chatThreadKey: "slack:C1:1.1",
    channelId: "C1",
    messageId: "2.1",
    kind: "follow_up",
    addressed: false,
    direct: false,
    author: { userId: "staff", userName: "Ada", fullName: "Ada" },
    text: "My feedback",
    files: [{ name: "note.txt", mimeType: "text/plain", url: "https://files.slack.com/note" }],
    mentions: [],
  };
  await h.bridge.receive(event);
  await h.bridge.receive(event);
  const sent = h.t3.calls.filter((call) => call.tool === "t3_thread_send_attachments");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.args.threadId, "agent-thread");
  assert.include(String(sent[0]!.args.message), "My feedback");
  assert.include(String(sent[0]!.args.message), "Reply through Executor");
  assert.lengthOf(sent[0]!.args.attachments as unknown[], 1);
  assert.isUndefined(h.store.binding(event.chatThreadKey));
  assert.isEmpty(h.store.pendingReplies());
  assert.isEmpty(posts);
  h.store.adoptBinding({
    chatThreadKey: event.chatThreadKey,
    channelId: "C1",
    threadId: "bound-thread",
    projectId: "project",
    createdByUserId: "staff",
  });
  await h.bridge.receive({ ...event, eventId: "slack:C1:3.1", messageId: "3.1", files: [] });
  assert.equal(lookups, 1);
  assert.equal(
    h.t3.calls.filter((call) => call.tool === "t3_thread_send").at(-1)!.args.threadId,
    "bound-thread",
  );
});

it("rejects support delivery clearly when Slack is unavailable", async () => {
  await using h = await harness();
  await h.send(request({ slack: { channelId: "C-SUPPORT" } }));
  assert.equal(h.office.calls.at(-1)?.args.result, "rejected");
  assert.include(
    String(h.office.calls.at(-1)?.args.errorMessage),
    "Slack channel is not configured",
  );
  assert.isFalse(h.t3.calls.some((call) => call.tool === "t3_thread_launch"));
});

it("sends an unsynced wake to the last conversation, while each original run answers its own", async () => {
  const posts: OutboundMessage[] = [];
  const slack: ChatPlatform = {
    id: "slack",
    name: "Slack",
    place: "Slack thread",
    access: { allowedUserIds: ["staff-1"] },
    person: (_id, name) => name,
    firstTurnNote: () => "",
    refusal: () => "",
    post: async (post) => {
      posts.push(post);
    },
    startConversation: async () => "slack:C:1",
  };
  await using h = await harness({ slack });
  await h.send(request({ slack: { channelId: "C" }, sync: false }));
  await h.bridge.receive({
    eventId: "staff",
    chatThreadKey: "slack:C:1",
    channelId: "C",
    messageId: "1.2",
    kind: "follow_up",
    direct: false,
    addressed: true,
    author: { userId: "staff-1", userName: "Ada", fullName: "Ada" },
    text: "Another question",
    files: [],
    mentions: [],
  });
  h.t3.wake("Background work finished");
  h.t3.finish("run-1", "Office answer");
  h.t3.finish("run-2", "Slack answer");
  await h.bridge.idle();
  assert.deepEqual(
    [...h.office.posts.values()].map((post) => post.text),
    ["Office answer"],
  );
  assert.deepEqual(
    posts.map((post) => post.text),
    ["Slack answer", "Background work finished"],
  );
});

it("shows synced questions in both conversations and closes both when Slack answers", async () => {
  const questionsDelivered = Promise.withResolvers<void>();
  const posts: OutboundMessage[] = [];
  let questionCount = 0;
  const questionPosted = (kind: string | undefined) => {
    if (kind === "question" && ++questionCount === 2) questionsDelivered.resolve();
  };
  const slack: ChatPlatform = {
    id: "slack",
    name: "Slack",
    place: "Slack thread",
    access: { allowedUserIds: ["staff-1"] },
    person: (_id, name) => name,
    firstTurnNote: () => "",
    refusal: () => "",
    post: async (post) => {
      posts.push(post);
      questionPosted(post.kind);
    },
    startConversation: async () => "slack:C:1",
  };
  await using h = await harness({ slack });
  h.office.onPost((post) => questionPosted(post.kind));
  await h.send(request({ slack: { channelId: "C" }, sync: true }));
  h.t3.questions.set("question-1", [
    {
      id: "choice",
      header: "Choice",
      question: "Which one?",
      options: [
        { label: "One", description: "First" },
        { label: "Two", description: "Second" },
      ],
    },
  ]);
  h.t3.items.push({
    position: 0,
    itemId: "question-item",
    type: "user_input_request",
    runId: "run-1",
    status: "waiting",
    text: "Which one?",
  });
  h.t3.tick();
  await questionsDelivered.promise;
  assert.lengthOf(h.store.openQuestions("office:chat-1"), 1);
  assert.lengthOf(h.store.openQuestions("slack:C:1"), 1);
  await h.bridge.receive({
    eventId: "staff-answer",
    chatThreadKey: "slack:C:1",
    channelId: "C",
    messageId: "1.2",
    kind: "follow_up",
    direct: false,
    addressed: true,
    author: { userId: "staff-1", userName: "Ada", fullName: "Ada" },
    text: "1",
    files: [],
    mentions: [],
  });
  assert.lengthOf(h.store.openQuestions("office:chat-1"), 0);
  assert.lengthOf(h.store.openQuestions("slack:C:1"), 0);
  assert.equal(
    h.t3.calls.filter(
      (call) => call.tool === "t3_pending_request" && call.args.action === "respond",
    ).length,
    1,
  );
  h.t3.finish("run-1", "Selected one");
  await h.bridge.idle();
  assert.isTrue(posts.some((post) => post.text === "Selected one"));
  assert.isTrue([...h.office.posts.values()].some((post) => post.text === "Selected one"));
});

it("starts a thread on the chat's own model, and switches the thread to it when it changes", async () => {
  await using h = await harness();
  const opus = {
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  };
  await h.send(request({ modelSelection: opus }));
  const launch = h.t3.calls.find((call) => call.tool === "t3_thread_launch")!;
  assert.deepEqual(launch.args.modelSelection, opus);
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();

  const sets = () =>
    h.t3.calls.filter(
      (call) => call.tool === "t3_thread_configure" && call.args.modelSelection !== undefined,
    );
  // Same model, options in another order: nothing to change.
  await h.send(
    request({
      eventId: "event-2",
      messageId: "message-2",
      firstTurn: false,
      modelSelection: { ...opus, options: [{ id: "effort", value: "high" }] },
    }),
  );
  assert.lengthOf(sets(), 0);
  h.t3.finish("run-2", "Done.");
  await h.bridge.idle();

  const terra = {
    instanceId: "codex",
    model: "gpt-6.1-terra",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  await h.send(
    request({
      eventId: "event-3",
      messageId: "message-3",
      firstTurn: false,
      modelSelection: terra,
    }),
  );
  assert.deepEqual(
    sets().map((call) => call.args.modelSelection),
    [terra],
  );
  // The switch lands before the message, so the message runs on it.
  const order = h.t3.calls.map((call) => call.tool);
  assert.isBelow(order.lastIndexOf("t3_thread_configure"), order.lastIndexOf("t3_thread_send"));
  h.t3.finish("run-3", "Done.");
  await h.bridge.idle();

  // Without the field, a follow-up leaves the thread's model alone.
  await h.send(request({ eventId: "event-4", messageId: "message-4", firstTurn: false }));
  assert.lengthOf(sets(), 1);
  // Nor did following need to read the thread's model back from T3.
  assert.lengthOf(
    h.t3.calls.filter((call) => call.tool === "t3_thread_configure"),
    1,
  );
});

it("keeps a !model switch in an Office chat until its picker changes", async () => {
  await using h = await harness();
  const astra = {
    instanceId: "codex",
    model: "gpt-6-astra",
    options: [{ id: "reasoningEffort", value: "medium" }],
  };
  const followUp = (n: number, text: string, modelSelection: typeof astra) =>
    request({
      eventId: `event-${n}`,
      messageId: `message-${n}`,
      firstTurn: false,
      text,
      modelSelection,
    });
  const sets = () =>
    h.t3.calls
      .filter(
        (call) => call.tool === "t3_thread_configure" && call.args.modelSelection !== undefined,
      )
      .map((call) => call.args.modelSelection);
  await h.send(request({ modelSelection: astra }));
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();

  // The composer still sends its picker's Astra with the switch, which keeps the effort.
  await h.send(followUp(2, "!opus look again", astra));
  assert.deepEqual(sets(), [
    {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "medium" }],
    },
  ]);
  h.t3.finish("run-2", "Done.");
  await h.bridge.idle();

  // The next message, on the same picker choice, stays on Opus.
  await h.send(followUp(3, "continue", astra));
  assert.lengthOf(sets(), 1);
  h.t3.finish("run-3", "Done.");
  await h.bridge.idle();

  // A new picker choice is followed, once.
  const terra = {
    instanceId: "codex",
    model: "gpt-6.1-terra",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  await h.send(followUp(4, "now the docs", terra));
  h.t3.finish("run-4", "Done.");
  await h.bridge.idle();
  await h.send(followUp(5, "and the tests", terra));
  assert.deepEqual(sets().slice(1), [terra]);
  h.t3.finish("run-5", "Done.");
  await h.bridge.idle();
});

const SLACK_CATCH_UP = "Before you act, read the original Slack thread in full";
const OLD_WORKTREES =
  "Worktree paths in the history below belong to the old server. Continue in your own worktree and don't go back to them; reach committed work through its branch.";
const DELIVER =
  "Send the requester's deliverable (files with chat_post, or the answer) as soon as it is built and checked. Run repository gates after that, or skip them for draft-only changes.";

it("tells a new thread for a Slack-linked chat with history to read the Slack thread first, and to deliver before gates", async () => {
  const slack: ChatPlatform = {
    id: "slack",
    name: "Slack",
    place: "Slack thread",
    access: { allowedUserIds: ["staff"] },
    channelRoutes: [{ channelId: "C1", projectId: "project-1" }],
    person: (_id, name) => name,
    firstTurnNote: () => "",
    refusal: () => "",
    post: async () => {},
  };
  await using h = await harness({ slack });
  for (const key of ["office:chat-1", "slack:C1:1.1"])
    h.store.insertSeed({
      chatThreadKey: key,
      channelId: key.startsWith("office") ? "chat-1" : "C1",
      chatId: "chat-1",
      oldThreadId: "old",
      sync: true,
    });
  await h.send(request({ history: { summary: "Worked in /old/worktrees/fix", recent: [] } }));
  const text = String(h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.message);
  assert.include(
    text,
    `${SLACK_CATCH_UP} (conversations.replies on channel C1, thread_ts 1.1) to catch up on what was asked and decided. The Office chat is https://office.example/chat/chat-1.`,
  );
  assert.include(text, OLD_WORKTREES);
  // The instructions come ahead of the history, which is only context.
  assert.isBelow(text.indexOf(SLACK_CATCH_UP), text.indexOf("Earlier Office conversation."));
  assert.include(text, DELIVER);
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();

  // Every later request repeats the delivery rule, and not the catch-up.
  await h.send(request({ eventId: "event-2", messageId: "message-2", firstTurn: false }));
  const send = String(h.t3.calls.find((call) => call.tool === "t3_thread_send")!.args.message);
  assert.include(send, DELIVER);
  assert.notInclude(send, SLACK_CATCH_UP);
});

it("gives a new thread for an Office-only chat with a summary the chat link alone", async () => {
  await using h = await harness();
  await h.send(request({ history: { summary: "We chose the smaller fix.", recent: [] } }));
  const text = String(h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.message);
  assert.include(
    text,
    "This chat continues in a new T3 thread. The Office chat is https://office.example/chat/chat-1.",
  );
  assert.include(text, OLD_WORKTREES);
  assert.notInclude(text, "Slack thread");
  assert.include(text, DELIVER);
});

it("tells a new thread for a seeded Slack conversation where its Slack thread and Office chat are, and to deliver before gates", async () => {
  const slack: ChatPlatform = {
    id: "slack",
    name: "Slack",
    place: "Slack thread",
    access: { allowedUserIds: ["staff"] },
    channelRoutes: [{ channelId: "C1", projectId: "project-1" }],
    person: (_id, name) => name,
    firstTurnNote: slackFirstTurnNote,
    refusal: () => "",
    post: async () => {},
  };
  await using h = await harness({ slack });
  h.store.insertSeed({
    chatThreadKey: "slack:C1:1.1",
    channelId: "C1",
    chatId: "chat-9",
    oldThreadId: "old",
    sync: false,
  });
  h.office.histories.set("chat-9", {
    kind: "ready",
    history: { summary: "Checkpoint", recent: [] },
  });
  await h.bridge.receive({
    eventId: "slack:C1:2.1",
    chatThreadKey: "slack:C1:1.1",
    channelId: "C1",
    messageId: "2.1",
    kind: "follow_up",
    addressed: false,
    direct: false,
    author: { userId: "staff", userName: "Ada", fullName: "Ada" },
    text: "Continue",
    files: [],
    mentions: [],
  });
  const text = String(h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.message);
  assert.include(
    text,
    `${SLACK_CATCH_UP} (conversations.replies on channel C1, thread_ts 1.1) to catch up on what was asked and decided. The Office chat is https://office.affil.ai/chat/chat-9.`,
  );
  assert.include(text, OLD_WORKTREES);
  // A Slack-originated first turn carries the delivery rule in Slack's own note.
  assert.include(text, DELIVER);
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  await h.bridge.receive({
    eventId: "slack:C1:3.1",
    chatThreadKey: "slack:C1:1.1",
    channelId: "C1",
    messageId: "3.1",
    kind: "follow_up",
    addressed: false,
    direct: false,
    author: { userId: "staff", userName: "Ada", fullName: "Ada" },
    text: "And the docs",
    files: [],
    mentions: [],
  });
  // A Slack follow-up doesn't repeat it.
  const send = String(h.t3.calls.find((call) => call.tool === "t3_thread_send")!.args.message);
  assert.notInclude(send, DELIVER);
});

const withoutModel = () => {
  const { model: _model, ...rest } = request();
  return rest;
};

const ASTRA = {
  instanceId: "codex",
  model: "gpt-6-astra",
  options: [{ id: "reasoningEffort", value: "medium" }],
};
const OPUS = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "medium" }],
};
const SOL = {
  instanceId: "codex",
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};

it.each([
  ["claude_gpt/claude-opus-5-5", OPUS],
  ["claudeAgent/claude-opus-5-5", OPUS],
  ["anthropic/claude-opus-5.5", OPUS],
  ["anthropic/claude-opus-5", OPUS],
  ["opus", OPUS],
  [
    "anthropic/claude-fable-5.1",
    {
      instanceId: "claudeAgent",
      model: "claude-fable-5-1",
      options: [{ id: "effort", value: "medium" }],
    },
  ],
  ["claude_gpt/gpt-6-astra", ASTRA],
  ["claudeAgent/gpt-6-astra", ASTRA],
  ["codex/gpt-6-astra", ASTRA],
  ["team/gpt-6-astra", ASTRA],
  ["ops/gpt-6-astra", ASTRA],
  ["guest/gpt-6-astra", ASTRA],
  ["astra", ASTRA],
  ["claude_gpt/gpt-6.1-sol", SOL],
  ["codex_proxy/gpt-6.1-sol", SOL],
  ["ops2/gpt-6.1-sol", SOL],
  ["team/gpt-6-sol", SOL],
  ["team/gpt-5.6-sol", SOL],
  ["sol", SOL],
  [
    "team/gpt-6-luna",
    {
      instanceId: "codex",
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
  ],
  [
    "team/gpt-5.6-luna",
    {
      instanceId: "codex",
      model: "gpt-6-luna",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
  ],
  ["claude_gpt/z-ai/glm-5.3-flash", { instanceId: "claudeAgent", model: "z-ai/glm-5.3" }],
  ["zai-org/GLM-5.3", { instanceId: "claudeAgent", model: "z-ai/glm-5.3" }],
  ["team/z-ai/glm-5.3", { instanceId: "claudeAgent", model: "z-ai/glm-5.3" }],
])("maps the Office model key %s onto a stock instance", (key, expected) => {
  assert.deepEqual(officeModel(key), expected);
});

it.each(["team/unknown-model", "a/b/gpt-6-astra", "z-ai/unknown"])(
  "leaves the Office model key %s unmapped",
  (key) => {
    assert.equal(officeModel(key), undefined);
  },
);

it("starts a chat with only a legacy model key on that model", async () => {
  await using h = await harness({ defaultModel: ASTRA });
  await h.send(request({ model: "claude_gpt/claude-opus-5-5" }));
  assert.deepEqual(
    h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.modelSelection,
    OPUS,
  );
});

it("runs a chat with no recorded model on the default, and logs it", async () => {
  await using h = await harness({ defaultModel: ASTRA });
  await h.send(withoutModel());
  assert.deepEqual(
    h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.modelSelection,
    ASTRA,
  );
  assert.include(h.logs, "Office: chat chat-1 has no recorded model; it runs on the default.");
});

const slackPlatformForSeeds = (): ChatPlatform => ({
  id: "slack",
  name: "Slack",
  place: "Slack thread",
  access: { allowedUserIds: ["staff"] },
  channelRoutes: [{ channelId: "C1", projectId: "project-1" }],
  person: (_id, name) => name,
  firstTurnNote: slackFirstTurnNote,
  refusal: () => "",
  post: async () => {},
});

const slackTurn = (ts: string, text: string): InboundEvent => ({
  eventId: `slack:C1:${ts}`,
  chatThreadKey: "slack:C1:1.1",
  channelId: "C1",
  messageId: ts,
  kind: "follow_up",
  addressed: false,
  direct: false,
  author: { userId: "staff", userName: "Ada", fullName: "Ada" },
  text,
  files: [],
  mentions: [],
});

async function seededSlack(chatModel: ModelSelection | undefined, now?: () => number) {
  const h = await harness({
    slack: slackPlatformForSeeds(),
    defaultModel: ASTRA,
    ...(now ? { now } : {}),
  });
  h.store.insertSeed({
    chatThreadKey: "slack:C1:1.1",
    channelId: "C1",
    chatId: "chat-9",
    oldThreadId: "old",
    sync: false,
  });
  if (chatModel) h.office.chatModels.set("chat-9", chatModel);
  return h;
}

const modelSets = (h: { t3: { calls: Array<{ tool: string; args: Record<string, unknown> }> } }) =>
  h.t3.calls
    .filter((call) => call.tool === "t3_thread_configure" && call.args.modelSelection !== undefined)
    .map((call) => call.args.modelSelection);

it("continues an imported Slack conversation on its Office chat's model", async () => {
  await using h = await seededSlack(OPUS);
  await h.bridge.receive(slackTurn("2.1", "Continue"));
  assert.deepEqual(
    h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.modelSelection,
    OPUS,
  );
  assert.deepEqual(h.store.followedModel("slack:C1:1.1"), OPUS);
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  // Once followed, a later Slack turn neither asks Office again nor switches.
  h.office.chatModels.set("chat-9", SOL);
  await h.bridge.receive(slackTurn("3.1", "And the docs"));
  assert.deepEqual(modelSets(h), []);
});

it("switches an imported thread left on the default to its chat's model on the next turn", async () => {
  // Before the fix: the conversation started on the default, with nothing followed.
  let clock = 0;
  await using h = await seededSlack(undefined, () => clock);
  const asked: Array<string> = [];
  const chatModel = h.office.api.chatModel;
  h.office.api.chatModel = async (chatId) => {
    asked.push(chatId);
    return chatModel(chatId);
  };
  await h.bridge.receive(slackTurn("2.1", "Continue"));
  assert.deepEqual(
    h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.modelSelection,
    ASTRA,
  );
  assert.include(h.logs, "Office chat chat-9 has no recorded model; it runs on the default.");
  assert.isUndefined(h.store.followedModel("slack:C1:1.1"));
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  // The next turns soon after neither ask Office again nor log it again.
  await h.bridge.receive(slackTurn("2.2", "One more"));
  h.t3.finish("run-2", "Done.");
  await h.bridge.idle();
  assert.deepEqual(asked, ["chat-9"]);
  assert.lengthOf(
    h.logs.filter((line) => line.includes("has no recorded model")),
    1,
  );

  // A model picked in Office later is followed once Office is asked again.
  h.office.chatModels.set("chat-9", OPUS);
  clock += 10 * 60_000 + 1;
  await h.bridge.receive(slackTurn("3.1", "And the docs"));
  assert.deepEqual(modelSets(h), [OPUS]);
  assert.deepEqual(h.store.followedModel("slack:C1:1.1"), OPUS);
  // The switch lands before the message, so the message runs on it.
  const order = h.t3.calls.map((call) => call.tool);
  assert.isBelow(order.lastIndexOf("t3_thread_configure"), order.lastIndexOf("t3_thread_send"));
});

it("keeps a !model switch made in an imported thread before the fix", async () => {
  let clock = 0;
  await using h = await seededSlack(undefined, () => clock);
  await h.bridge.receive(slackTurn("2.1", "Continue"));
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  // Someone switched the thread on purpose while nothing was followed.
  await h.t3.tools.call("t3_thread_configure", { threadId: "thread-1", modelSelection: SOL });

  h.office.chatModels.set("chat-9", OPUS);
  clock += 10 * 60_000 + 1;
  await h.bridge.receive(slackTurn("3.1", "And the docs"));
  assert.deepEqual(modelSets(h), [SOL]);
  assert.deepEqual(h.store.followedModel("slack:C1:1.1"), OPUS);
});

it("keeps a !model switch made in an imported thread after it follows its chat", async () => {
  await using h = await seededSlack(OPUS);
  await h.bridge.receive(slackTurn("2.1", "Continue"));
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  await h.bridge.receive(slackTurn("3.1", "!sol take another look"));
  h.t3.finish("run-2", "Done.");
  await h.bridge.idle();
  await h.bridge.receive(slackTurn("4.1", "and the tests"));
  assert.deepEqual(modelSets(h), [SOL]);
});

it("switches an Office chat's thread left on the default once Office sends its recorded model", async () => {
  await using h = await harness({ defaultModel: ASTRA });
  // Started before Office sent the model its old thread ran: on the default, nothing followed.
  await h.send(withoutModel());
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  assert.isUndefined(h.store.followedModel("office:chat-1"));
  await h.send(
    request({ eventId: "event-2", messageId: "message-2", firstTurn: false, modelSelection: OPUS }),
  );
  assert.deepEqual(modelSets(h), [OPUS]);
  assert.deepEqual(h.store.followedModel("office:chat-1"), OPUS);
});

it("still switches a thread left on a former default after the default changes", async () => {
  const SOL = { instanceId: "codex", model: "gpt-6.1-sol" };
  // The default is now Opus; this thread started under the old Astra default.
  await using h = await harness({ defaultModel: OPUS, formerModels: [ASTRA], threadModel: ASTRA });
  await h.send(withoutModel());
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  await h.send(
    request({ eventId: "event-2", messageId: "message-2", firstTurn: false, modelSelection: SOL }),
  );
  assert.deepEqual(modelSets(h), [SOL]);
});

it("keeps a thread on a model that was never a default", async () => {
  const SOL = { instanceId: "codex", model: "gpt-6.1-sol" };
  const TERRA = { instanceId: "codex", model: "gpt-6.1-terra" };
  await using h = await harness({ defaultModel: OPUS, formerModels: [TERRA], threadModel: ASTRA });
  await h.send(withoutModel());
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  await h.send(
    request({ eventId: "event-2", messageId: "message-2", firstTurn: false, modelSelection: SOL }),
  );
  assert.deepEqual(modelSets(h), []);
});

it("keeps a person's pick of a former default made while Office couldn't say the chat's model", async () => {
  await using h = await harness({
    slack: slackPlatformForSeeds(),
    defaultModel: OPUS,
    formerModels: [ASTRA],
    // T3 reports the model the person picked.
    threadModel: ASTRA,
  });
  h.store.insertSeed({
    chatThreadKey: "slack:C1:1.1",
    channelId: "C1",
    chatId: "chat-9",
    oldThreadId: "old",
    sync: false,
  });
  const chatModel = h.office.api.chatModel;
  h.office.api.chatModel = async () => {
    throw new Error("Office chatModel failed.");
  };
  await h.bridge.receive(slackTurn("2.1", "Continue"));
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  await h.bridge.receive(slackTurn("3.1", "!astra"));
  await h.bridge.idle();
  const picked = modelSets(h);
  assert.lengthOf(picked, 1);
  h.office.api.chatModel = chatModel;
  h.office.chatModels.set("chat-9", OPUS);
  await h.bridge.receive(slackTurn("4.1", "And the docs"));
  assert.deepEqual(modelSets(h), picked);
  assert.deepEqual(h.store.followedModel("slack:C1:1.1"), OPUS);
});

it("keeps a pick that starts the thread while Office couldn't say the chat's model", async () => {
  await using h = await harness({
    slack: slackPlatformForSeeds(),
    defaultModel: OPUS,
    formerModels: [ASTRA],
    threadModel: ASTRA,
  });
  h.store.insertSeed({
    chatThreadKey: "slack:C1:1.1",
    channelId: "C1",
    chatId: "chat-9",
    oldThreadId: "old",
    sync: false,
  });
  const chatModel = h.office.api.chatModel;
  h.office.api.chatModel = async () => {
    throw new Error("Office chatModel failed.");
  };
  await h.bridge.receive(slackTurn("2.1", "!astra Continue"));
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  assert.isTrue(h.store.modelSwitched("slack:C1:1.1"));
  h.office.api.chatModel = chatModel;
  h.office.chatModels.set("chat-9", OPUS);
  await h.bridge.receive(slackTurn("3.1", "And the docs"));
  // The thread stays on the Astra the person picked.
  assert.deepEqual(modelSets(h), []);
  assert.deepEqual(h.store.followedModel("slack:C1:1.1"), OPUS);
});

it("runs a Slack turn on the thread's model when Office can't say the chat's", async () => {
  await using h = await seededSlack(undefined);
  h.office.api.chatModel = async () => {
    throw new Error("Office chatModel failed.");
  };
  await h.bridge.receive(slackTurn("2.1", "Continue"));
  assert.deepEqual(
    h.t3.calls.find((call) => call.tool === "t3_thread_launch")!.args.modelSelection,
    ASTRA,
  );
  assert.include(
    h.logs,
    "Office chat chat-9's model couldn't be read; this turn keeps the thread's model.",
  );
});
