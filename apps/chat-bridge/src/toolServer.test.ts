// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import type { OutboundMessage, Reaction } from "./platform.ts";
import { callTool, slackStartRefusal, type ToolDeps } from "./toolServer.ts";

function harness() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chat-bridge-"));
  const workspace = NodePath.join(root, "workspace");
  NodeFS.mkdirSync(workspace);
  NodeFS.writeFileSync(NodePath.join(workspace, "report.txt"), "hello");
  NodeFS.writeFileSync(NodePath.join(root, "secret.txt"), "nope");
  const posts: Array<OutboundMessage> = [];
  const reactions: Array<Reaction> = [];
  const deps: ToolDeps = {
    bindingByChatKey: (chatKey) =>
      chatKey === "key-1"
        ? {
            chatThreadKey: "slack:C1:100.1",
            channelId: "C1",
            projectId: "p",
            threadId: "t",
            chatKey,
            createdByUserId: "U1",
          }
        : undefined,
    workspaceRoots: async () => [workspace],
    post: async (message) => void posts.push(message),
    react: async (reaction) => {
      reactions.push(reaction);
      return reaction.chatThreadKey.startsWith("linear:")
        ? "Reactions don't show here."
        : undefined;
    },
    setStatus: (_chatThreadKey, status) => status !== "idle thread",
  };
  return { deps, posts, reactions, root };
}

const textOf = (result: Awaited<ReturnType<typeof callTool>>) =>
  result.content.map((part) => ("text" in part ? part.text : "")).join("");

it("posts text and workspace files to the chat key's thread", async () => {
  const { deps, posts } = harness();
  const result = await callTool(deps, "chat_post", {
    chatKey: "key-1",
    kind: "done",
    text: "here you go",
    files: [{ path: "report.txt" }],
  });
  assert.isUndefined(result.isError);
  assert.strictEqual(posts[0]?.chatThreadKey, "slack:C1:100.1");
  assert.strictEqual(posts[0]?.text, "here you go");
  assert.deepStrictEqual(
    posts[0]?.files?.map((file) => [file.filename, file.data.toString()]),
    [["report.txt", "hello"]],
  );
});

it("refuses an unknown chat key and files outside the workspace", async () => {
  const { deps, posts, root } = harness();
  const unknown = await callTool(deps, "chat_post", { chatKey: "nope", text: "hi" });
  assert.isTrue(unknown.isError);
  for (const filePath of ["../secret.txt", NodePath.join(root, "secret.txt"), "missing.txt"]) {
    const result = await callTool(deps, "chat_post", {
      chatKey: "key-1",
      kind: "done",
      files: [{ path: filePath }],
    });
    assert.isTrue(result.isError, filePath);
  }
  assert.include(
    textOf(
      await callTool(deps, "chat_post", {
        chatKey: "key-1",
        kind: "done",
        files: [{ path: "../secret.txt" }],
      }),
    ),
    "outside the workspace",
  );
  assert.deepStrictEqual(posts, []);
});

it("requires a post's kind: question, blocked, done or answer", async () => {
  const { deps, posts } = harness();
  for (const kind of [undefined, "update", "progress", 3]) {
    const result = await callTool(deps, "chat_post", { chatKey: "key-1", kind, text: "hi" });
    assert.isTrue(result.isError, String(kind));
    assert.include(textOf(result), "question, blocked, done, answer");
  }
  assert.deepStrictEqual(posts, []);
  for (const kind of ["question", "blocked", "done", "answer"])
    assert.isUndefined(
      (await callTool(deps, "chat_post", { chatKey: "key-1", kind, text: kind })).isError,
    );
  // Every kind posts as before, so Linear and Office treat it as they always have.
  assert.deepStrictEqual(
    posts.map((post) => [post.text, post.kind]),
    [
      ["question", "update"],
      ["blocked", "update"],
      ["done", "update"],
      ["answer", "update"],
    ],
  );
  // The core still learns the agent's kind, to tell when a post answered the person.
  assert.deepStrictEqual(
    posts.map((post) => post.postKind),
    ["question", "blocked", "done", "answer"],
  );
});

it("reacts with a bare emoji name and checks the message id", async () => {
  const { deps, reactions } = harness();
  const result = await callTool(deps, "chat_react", {
    chatKey: "key-1",
    messageId: "100.2",
    emoji: ":white_check_mark:",
  });
  assert.isUndefined(result.isError);
  assert.deepStrictEqual(reactions, [
    { chatThreadKey: "slack:C1:100.1", messageId: "100.2", emoji: "white_check_mark" },
  ]);
  const bad = await callTool(deps, "chat_react", {
    chatKey: "key-1",
    messageId: "../abc",
    emoji: "eyes",
  });
  assert.isTrue(bad.isError);
});

it("passes on what the platform says instead of reacting, such as on Linear", async () => {
  const { deps } = harness();
  const linear = {
    ...deps,
    bindingByChatKey: (chatKey: string) => {
      const binding = deps.bindingByChatKey(chatKey);
      return binding && { ...binding, chatThreadKey: "linear:issue-1" };
    },
  };
  const result = await callTool(linear, "chat_react", {
    chatKey: "key-1",
    messageId: "c-1",
    emoji: "eyes",
  });
  assert.isUndefined(result.isError);
  assert.strictEqual(textOf(result), "Reactions don't show here.");
});

it("connects a thread to Linear only with a valid thread id and one issue", async () => {
  const { deps } = harness();
  const requests: Array<unknown> = [];
  const linear = {
    ...deps,
    startLinear: async (request: unknown) => {
      requests.push(request);
      return "ENG-9 now shows the work.";
    },
  };
  // No chat key: an orchestrator isn't a chat's thread.
  const started = await callTool(linear, "linear_start", {
    threadId: "mcp:launch:abc",
    newIssue: { team: "ENG", title: "Fix it" },
  });
  // Earlier callers name it childThreadId.
  await callTool(linear, "linear_start", { childThreadId: "mcp:launch:def", issue: "ENG-1" });
  assert.isUndefined(started.isError);
  assert.strictEqual(textOf(started), "ENG-9 now shows the work.");
  assert.deepStrictEqual(requests, [
    {
      threadId: "mcp:launch:abc",
      issue: undefined,
      newIssue: { team: "ENG", title: "Fix it", description: undefined },
      replace: false,
    },
    { threadId: "mcp:launch:def", issue: "ENG-1", newIssue: undefined, replace: false },
  ]);
  for (const bad of [
    { childThreadId: "mcp:launch:abc" },
    { childThreadId: "mcp:launch:abc", issue: "ENG-1", newIssue: { team: "ENG", title: "x" } },
    { childThreadId: "mcp:launch:abc", issue: "not an issue" },
    { childThreadId: "../x y", issue: "ENG-1" },
    { childThreadId: "mcp:launch:abc", newIssue: { team: "ENG", title: "" } },
  ]) {
    assert.isTrue((await callTool(linear, "linear_start", bad)).isError, JSON.stringify(bad));
  }
  assert.lengthOf(requests, 2);
  // Without Linear the tool refuses.
  const off = await callTool(deps, "linear_start", { childThreadId: "t", issue: "ENG-1" });
  assert.isTrue(off.isError);
});

it("starts a Slack thread in a channel or a DM only with valid ids and an opening message", async () => {
  const { deps } = harness();
  const requests: Array<unknown> = [];
  const slack = {
    ...deps,
    startSlack: async (request: unknown) => {
      requests.push(request);
      return "Started a Slack thread.";
    },
  };
  for (const channel of ["C0CHANNEL01", "U0123ABCD", "D0123ABCD"]) {
    const started = await callTool(slack, "slack_start", {
      threadId: "mcp:launch:abc",
      channel,
      text: " Picking this up here. ",
    });
    assert.isUndefined(started.isError, channel);
  }
  assert.deepStrictEqual(requests[1], {
    threadId: "mcp:launch:abc",
    channel: "U0123ABCD",
    text: "Picking this up here.",
  });
  const reply = await callTool(slack, "slack_start", {
    threadId: "mcp:launch:abc",
    channel: "C0CHANNEL01",
    text: "On it.",
    replyTo: "1794278854.319499",
  });
  assert.isUndefined(reply.isError);
  assert.deepStrictEqual(requests[3], {
    threadId: "mcp:launch:abc",
    channel: "C0CHANNEL01",
    text: "On it.",
    replyTo: "1794278854.319499",
  });
  for (const bad of [
    {
      threadId: "mcp:launch:abc",
      channel: "C0CHANNEL01",
      text: "hi",
      replyTo: "p1794278854319499",
    },
    { threadId: "mcp:launch:abc", channel: "U0123ABCD", text: "hi", replyTo: "1794278854.319499" },
    { threadId: "mcp:launch:abc", channel: "#general", text: "hi" },
    { threadId: "mcp:launch:abc", channel: "C0CHANNEL01", text: "  " },
    { threadId: "mcp:launch:abc", channel: "C0CHANNEL01", text: "x".repeat(4_001) },
    { threadId: "../x y", channel: "C0CHANNEL01", text: "hi" },
  ]) {
    assert.isTrue((await callTool(slack, "slack_start", bad)).isError, JSON.stringify(bad));
  }
  assert.lengthOf(requests, 4);
  assert.isTrue((await callTool(deps, "slack_start", requests[0] as never)).isError);
});

it("lets slack_start post only to the bridge's channels and to people allowed to use the bot", () => {
  const access = {
    channelProjects: [{ channelId: "C0CHANNEL01" }],
    allowedUserIds: ["U0123ABCD"],
    allowEveryone: false,
  };
  assert.isUndefined(slackStartRefusal(access, "C0CHANNEL01"));
  assert.isUndefined(slackStartRefusal(access, "U0123ABCD"));
  assert.match(
    slackStartRefusal(access, "C0OTHER0001") ?? "",
    /isn't one of the bridge's channels/,
  );
  assert.match(slackStartRefusal(access, "U0STRANGER1") ?? "", /isn't allowed/);
  assert.match(slackStartRefusal(access, "D0123ABCD") ?? "", /isn't one of the bridge's channels/);
  assert.isUndefined(slackStartRefusal({ ...access, allowEveryone: true }, "U0STRANGER1"));
});

it("sets a status only while the thread has a run in flight", async () => {
  const { deps } = harness();
  const set = await callTool(deps, "chat_status", { chatKey: "key-1", status: "is testing…" });
  assert.isUndefined(set.isError);
  const idle = await callTool(deps, "chat_status", { chatKey: "key-1", status: "idle thread" });
  assert.isTrue(idle.isError);
});
