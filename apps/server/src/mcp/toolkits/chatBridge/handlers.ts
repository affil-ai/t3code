import { OrchestratorMcpFailure, PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ChatBridgeService } from "../../../chatBridge/ChatBridgeService.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ChatBridgeToolkit } from "./tools.ts";

const notBound =
  "This thread does not answer a chat thread. Only a thread a Slack message started can post there.";
const noWorkspace = "This thread has no workspace, so it cannot send files.";
const MAX_MB = PROVIDER_SEND_TURN_MAX_FILE_BYTES / (1024 * 1024);

const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const make = Effect.gen(function* () {
  const bridge = yield* ChatBridgeService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  /** Reads a workspace file; a path that resolves outside the workspace is refused. */
  const readWorkspaceFile = Effect.fn("ChatBridgeHandlers.readWorkspaceFile")(function* (
    root: string,
    file: { readonly path: string; readonly name?: string | undefined },
  ) {
    const realRoot = yield* fileSystem
      .realPath(root)
      .pipe(Effect.mapError(() => denied(noWorkspace)));
    const resolved = yield* fileSystem
      .realPath(path.resolve(root, file.path))
      .pipe(Effect.mapError(() => invalid(`${file.path} does not exist.`)));
    const relative = path.relative(realRoot, resolved);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return yield* denied(`${file.path} is outside the workspace. Copy it into ${root} first.`);
    }
    const info = yield* fileSystem
      .stat(resolved)
      .pipe(Effect.mapError(() => invalid(`${file.path} could not be read.`)));
    if (info.type !== "File") return yield* invalid(`${file.path} is not a file.`);
    if (Number(info.size) > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
      return yield* invalid(`${file.path} is larger than ${MAX_MB} MB.`);
    }
    const data = yield* fileSystem
      .readFile(resolved)
      .pipe(Effect.mapError(() => invalid(`${file.path} could not be read.`)));
    return { data: Buffer.from(data), filename: file.name ?? path.basename(resolved) };
  });

  return {
    chat_post: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { thread } = yield* McpInvocationContext.McpInvocationContext;
        if (thread === undefined) return yield* denied(notBound);
        const requested = input.files ?? [];
        const text = input.text?.trim() ?? "";
        if (text === "" && requested.length === 0) {
          return yield* invalid("Pass text, files, or both.");
        }
        const files: Array<{ readonly data: Buffer; readonly filename: string }> = [];
        if (requested.length > 0) {
          const root = yield* threadWorkspaceRoot(thread.threadId);
          if (root === undefined) return yield* denied(noWorkspace);
          for (const file of requested) files.push(yield* readWorkspaceFile(root, file));
        }
        const posted = yield* bridge
          .postFromThread({ threadId: thread.threadId, text, files })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
          );
        if (Option.isNone(posted)) return yield* denied(notBound);
        return {
          chatThreadKey: posted.value.chatThreadKey,
          files: files.map((file) => file.filename),
        };
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof ChatBridgeToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(ChatBridgeToolkit, make);
