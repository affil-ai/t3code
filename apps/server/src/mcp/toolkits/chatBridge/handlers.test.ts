import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ChatBridgeService } from "../../../chatBridge/ChatBridgeService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as ChatBridgeHandlers from "./handlers.ts";
import { ChatBridgeToolkit } from "./tools.ts";

/** A thread a Slack message started, and one nothing in chat started. */
const BOUND = ThreadId.make("bound");
const UNBOUND = ThreadId.make("unbound");

const invocation = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: `session-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 1,
});

interface Posted {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly files: ReadonlyArray<{ readonly filename: string; readonly content: string }>;
}

const makeHarness = Effect.fn("chatBridgeToolkitTestHarness")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-chat-post-" });
  const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-chat-post-outside-" });
  yield* fileSystem.writeFileString(path.join(workspace, "report.md"), "# Report");
  yield* fileSystem.writeFileString(path.join(outside, "secret.txt"), "secret");
  yield* fileSystem.symlink(path.join(outside, "secret.txt"), path.join(workspace, "link.txt"));

  const posted: Array<Posted> = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.succeed({
          ...McpToolAccessTestkit.liveThreadShell(threadId),
          worktreePath: workspace,
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ChatBridgeService)({
      postFromThread: (input) =>
        Effect.sync(() => {
          if (input.threadId !== BOUND) return Option.none();
          posted.push({
            threadId: input.threadId,
            text: input.text,
            files: input.files.map((file) => ({
              filename: file.filename,
              content: file.data.toString("utf8"),
            })),
          });
          return Option.some({ chatThreadKey: "slack:C0MAPPED:1700000000.000100" });
        }),
    }),
    NodeServices.layer,
  );
  const toolkit = yield* ChatBridgeToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ChatBridgeHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  const call = (
    params: Parameters<typeof toolkit.handle<"chat_post">>[1],
    caller: ThreadId = BOUND,
  ) =>
    toolkit.handle("chat_post", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(caller)),
      Effect.provide(dependencies),
    );
  return { call, posted, outside, path };
});

describe("chat_post", () => {
  it.effect("posts text and workspace files to the bound chat thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.call({
          text: "Here is the report, <@U0VIVEK>.",
          files: [{ path: "report.md" }],
        });
        expect(result.isFailure).toBe(false);
        expect(result.result).toEqual({
          chatThreadKey: "slack:C0MAPPED:1700000000.000100",
          files: ["report.md"],
        });
        expect(harness.posted).toEqual([
          {
            threadId: BOUND,
            text: "Here is the report, <@U0VIVEK>.",
            files: [{ filename: "report.md", content: "# Report" }],
          },
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses files outside the workspace, including through a symlink", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const absolute = yield* harness.call({
          files: [{ path: harness.path.join(harness.outside, "secret.txt") }],
        });
        expect(absolute.isFailure).toBe(true);
        expect(absolute.result).toMatchObject({ code: "capability_denied" });
        const linked = yield* harness.call({ files: [{ path: "link.txt" }] });
        expect(linked.isFailure).toBe(true);
        expect(linked.result).toMatchObject({ code: "capability_denied" });
        expect(harness.posted).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a thread that answers no chat thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.call({ text: "hello" }, UNBOUND);
        expect(result.isFailure).toBe(true);
        expect(result.result).toMatchObject({ code: "capability_denied" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
