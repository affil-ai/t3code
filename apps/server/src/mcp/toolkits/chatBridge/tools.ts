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

export const ChatBridgeToolkit = Toolkit.make(ChatPostTool);
