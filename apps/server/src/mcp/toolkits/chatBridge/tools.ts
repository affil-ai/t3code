// fork: chat-bridge — the agent's way to post files and messages to the Slack thread it answers.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import { ChatBridgeService } from "../../../chatBridge/ChatBridgeService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const CHAT_POST_MAX_FILES = 10;

export const ChatPostInput = Schema.Struct({
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(12_000))),
  files: Schema.optional(
    Schema.Array(
      Schema.Struct({
        /** Absolute, or relative to the thread's workspace. */
        path: Schema.String.check(Schema.isNonEmpty()),
        /** The name Slack shows; defaults to the file's own name. */
        name: Schema.optional(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(255))),
      }),
    ).check(Schema.isMaxLength(CHAT_POST_MAX_FILES)),
  ),
});
export type ChatPostInput = typeof ChatPostInput.Type;

export const ChatPostResult = Schema.Struct({
  chatThreadKey: Schema.String,
  files: Schema.Array(Schema.String),
});

const ChatPostTool = Tool.make("chat_post", {
  description:
    "Post a message, files, or both to the Slack thread this T3 thread answers. Your final message is posted there anyway, so use this for files and for updates before the run ends. Files must be inside your workspace, up to 10 per call and 50 MB each. Write <@USERID> to mention someone.",
  parameters: ChatPostInput,
  success: ChatPostResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ChatBridgeService,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    FileSystem.FileSystem,
    Path.Path,
  ],
})
  .annotate(Tool.Title, "Post to the chat thread")
  .annotate(Tool.Destructive, false);

export const ChatReactInput = Schema.Struct({
  /** The message id shown in the turn, such as `1700000000.000100`. */
  messageId: Schema.String.check(Schema.isPattern(/^\d+\.\d+$/)),
  /** A Slack emoji name, with or without colons, such as `eyes` or `:white_check_mark:`. */
  emoji: Schema.String.check(Schema.isPattern(/^:?[a-z0-9_+'-]+:?$/), Schema.isMaxLength(100)),
});
export type ChatReactInput = typeof ChatReactInput.Type;

export const ChatReactResult = Schema.Struct({
  chatThreadKey: Schema.String,
  emoji: Schema.String,
});

const ChatReactTool = Tool.make("chat_react", {
  description:
    "React with an emoji to a message in the Slack thread this T3 thread answers. Pass the message id shown in the turn and a Slack emoji name such as eyes, white_check_mark or thumbsup.",
  parameters: ChatReactInput,
  success: ChatReactResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ChatBridgeService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "React in the chat thread")
  .annotate(Tool.Destructive, false);

export const ChatBridgeToolkit = Toolkit.make(ChatPostTool, ChatReactTool);
