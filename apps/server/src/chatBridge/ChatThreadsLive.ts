/**
 * `ChatThreads` over T3 orchestration: new chat threads launch like a
 * scheduled task's fresh thread, and follow-ups queue like a queued send.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ChatThreads, ChatThreadsError } from "./ChatBridgeCore.ts";

const threadsError = (message: string) => (cause: unknown) =>
  new ChatThreadsError({ message, cause });

export const layer = Layer.effect(
  ChatThreads,
  Effect.gen(function* () {
    const launch = yield* ThreadLaunchService.ThreadLaunchService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const settings = yield* ServerSettings.ServerSettingsService;

    return ChatThreads.of({
      start: Effect.fn("ChatThreads.start")(function* (input) {
        const project = yield* projects
          .getById(input.projectId)
          .pipe(Effect.mapError(threadsError("Could not read the project.")));
        if (Option.isNone(project)) {
          return yield* new ChatThreadsError({
            message: `Project ${input.projectId} was not found.`,
          });
        }
        const current = yield* settings.getSettings.pipe(
          Effect.mapError(threadsError("Could not read server settings.")),
        );
        const modelSelection = project.value.defaultModelSelection ?? current.defaultModelSelection;
        if (modelSelection === null) {
          return yield* new ChatThreadsError({
            message: `Project ${input.projectId} has no default model, so a chat request cannot start a thread there.`,
          });
        }
        const launched = yield* launch
          .launch({
            commandId: input.commandId,
            projectId: input.projectId,
            title: input.title,
            modelSelection,
            runtimeMode: current.defaultRuntimeMode,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: { messageId: input.messageId, text: input.text, attachments: [] },
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(Effect.mapError(threadsError("Could not start the thread.")));
        return launched.threadId;
      }),
      queue: Effect.fn("ChatThreads.queue")(function* (input) {
        yield* threads
          .sendToThread({
            projectId: input.projectId,
            commandId: input.commandId,
            threadId: input.threadId,
            messageId: input.messageId,
            text: input.text,
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(Effect.mapError(threadsError("Could not queue the message.")));
      }),
      finalAnswer: Effect.fn("ChatThreads.finalAnswer")(function* (input) {
        const { messages } = yield* threads
          .getProjectThreadRecords(
            { projectId: input.projectId, threadId: input.threadId },
            ["messages"],
            { messageRunIds: [input.run.id] },
          )
          .pipe(Effect.mapError(threadsError("Could not read the run's messages.")));
        const assistant = messages.filter(
          (message) =>
            message.role === "assistant" &&
            message.runId === input.run.id &&
            message.text.trim() !== "",
        );
        // Native subagent output in the same run carries its own node, so the
        // root agent's last message wins when the run records its root node.
        const answer =
          assistant.findLast((message) => message.nodeId === input.run.rootNodeId) ??
          assistant.at(-1);
        return Option.map(Option.fromUndefinedOr(answer), (message) => message.text);
      }),
    });
  }),
);
