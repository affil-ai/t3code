// @effect-diagnostics nodeBuiltinImport:off -- Tests for a plain Node channel and expiring files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, expect, it, vi } from "vite-plus/test";

import { Bridge, type InboundEvent } from "../bridge.ts";
import type { ChatPlatform, OutboundMessage } from "../platform.ts";
import { BridgeStore, ensureSchema } from "../store.ts";
import { T3Threads, type RunStatus } from "../threads.ts";
import type { T3Tools } from "../t3Client.ts";
import { callTool } from "../toolServer.ts";
import { ArticleFiles } from "./article.ts";
import type { InboxEvent, OfficeApi, OfficeMutations, PreparedRequest } from "./client.ts";
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
  let listener = (_events: InboxEvent[]) => {};
  let posted = (_post: OfficeMutations["post"]["args"]) => {};
  const api: OfficeApi = {
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
        const prepared = requests.get((args as OfficeMutations["prepare"]["args"]).eventId);
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
      if (failures.has(tool)) throw new Error("T3 unavailable");
      let result: unknown;
      if (tool === "t3_thread_launch") result = { threadId: "thread-1", runId: startRun() };
      else if (tool === "t3_thread_send" || tool === "t3_thread_send_attachments") {
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
    runs,
    failures,
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
      modelSelection: { instanceId: "codex", model: "default-model" },
    }),
    settings: {},
    platforms: [channel.platform, ...(options.slack ? [options.slack] : [])],
    log: (line) => {
      logs.push(line);
    },
    sleep: async () => {},
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
    args: { chatId: "chat-1", state: "active", text: "" },
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
    args: { chatId: "chat-1", state: "active", text: "" },
  });
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
  const args = { chatKey: binding.chatKey, text: "Report", files: [{ path: file }] };
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
  await expect(
    NodeFSP.stat(NodePath.join(h.home, "office-article/chat-1/article-1.json")),
  ).rejects.toThrow(/ENOENT/);
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

it("acks redelivery after a crash before ack without starting or posting again", async () => {
  await using h = await harness();
  h.office.fail.add("ack");
  await h.send();
  h.t3.finish("run-1", "Done.");
  await h.bridge.idle();
  assert.isTrue(h.store.isHandled("office:event-1"));
  await h.channel.close();
  h.office.fail.clear();
  await using restarted = await harness({ office: h.office, t3: h.t3, db: h.db, home: h.home });
  await restarted.bridge.resume();
  await restarted.send();
  assert.equal(h.t3.calls.filter((call) => call.tool === "t3_thread_launch").length, 1);
  assert.equal(h.office.posts.size, 1);
  assert.deepEqual(h.office.calls.at(-1), {
    name: "ack",
    args: { eventId: "event-1", result: "stored" },
  });
});

it("adopts a readable legacy thread without owing its old answer, or starts fresh when unreadable", async () => {
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
    await h.send(request({ legacyThreadId: "legacy-thread" }));
    assert.equal(
      h.t3.calls.filter((call) => call.tool === "t3_thread_launch").length,
      readable ? 0 : 1,
    );
    assert.equal(
      h.store.binding("office:chat-1")!.threadId,
      readable ? "legacy-thread" : "thread-1",
    );
    assert.isFalse(h.store.isOwed("legacy-run"));
    if (readable) assert.lengthOf(h.store.bindingsForThread("legacy-thread"), 2);
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

it.each([false, true])(
  "links support conversations with sync %s, preserving origin routing and staff follow-ups",
  async (sync) => {
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
