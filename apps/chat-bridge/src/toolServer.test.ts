// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import type { SlackOutboundMessage, SlackReaction } from "./slackHost.ts";
import { callTool, type ToolDeps } from "./toolServer.ts";

function harness() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "chat-bridge-"));
  const workspace = NodePath.join(root, "workspace");
  NodeFS.mkdirSync(workspace);
  NodeFS.writeFileSync(NodePath.join(workspace, "report.txt"), "hello");
  NodeFS.writeFileSync(NodePath.join(root, "secret.txt"), "nope");
  const posts: Array<SlackOutboundMessage> = [];
  const reactions: Array<SlackReaction> = [];
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
    react: async (reaction) => void reactions.push(reaction),
  };
  return { deps, posts, reactions, root };
}

const textOf = (result: Awaited<ReturnType<typeof callTool>>) =>
  result.content.map((part) => ("text" in part ? part.text : "")).join("");

it("posts text and workspace files to the chat key's thread", async () => {
  const { deps, posts } = harness();
  const result = await callTool(deps, "chat_post", {
    chatKey: "key-1",
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
      files: [{ path: filePath }],
    });
    assert.isTrue(result.isError, filePath);
  }
  assert.include(
    textOf(
      await callTool(deps, "chat_post", { chatKey: "key-1", files: [{ path: "../secret.txt" }] }),
    ),
    "outside the workspace",
  );
  assert.deepStrictEqual(posts, []);
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
    messageId: "abc",
    emoji: "eyes",
  });
  assert.isTrue(bad.isError);
});
