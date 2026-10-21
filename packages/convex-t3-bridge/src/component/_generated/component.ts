/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> = {
  actions: {
    importThread: FunctionReference<
      "action",
      "internal",
      {
        config: string;
        conversationKey: string;
        onEvent: string;
        threadId: string;
      },
      null,
      Name
    >;
    sweep: FunctionReference<"action", "internal", { after?: string }, null, Name>;
  };
  bridge: {
    authorizeReply: FunctionReference<"query", "internal", { replyKey: string }, string, Name>;
    beginImport: FunctionReference<
      "mutation",
      "internal",
      {
        config: string;
        conversationKey: string;
        onEvent: string;
        threadId: string;
      },
      {
        _creationTime: number;
        _id: string;
        activeRunId?: string;
        cancelAttempt: number;
        cancelNextAt: number;
        cancelPending: boolean;
        cancelRunId?: string;
        cancelVersion: number;
        config: string;
        conversationKey: string;
        generation: number;
        importing: boolean;
        instructionsPending: boolean;
        lastError?: string;
        launch?: {
          instructions?: string;
          interactionMode?: "default" | "plan";
          modelSelection?: {
            instanceId: string;
            model: string;
            options?: Record<string, string | boolean>;
          };
          projectId: string;
          runtimeMode?: "full-access" | "auto" | "approval-required" | "auto-accept-edits";
          title: string;
          workspaceStrategy?:
            | { branch?: string; type: "root" }
            | {
                baseRef: string;
                branch?: string;
                startFromOrigin?: boolean;
                type: "worktree";
              }
            | {
                branch?: string;
                type: "existing_worktree";
                worktreePath: string;
              };
        };
        nonce: string;
        onEvent: string;
        position: number;
        projectId?: string;
        threadId?: string;
        threadUpdatedAt?: string;
        watchFailures: number;
        watchNextAt: number;
        watchStopped: boolean;
        watcherLeaseUntil?: number;
        watcherToken?: string;
      },
      Name
    >;
    cancel: FunctionReference<
      "mutation",
      "internal",
      { config: string; conversationKey: string; onEvent: string },
      null,
      Name
    >;
    getConversation: FunctionReference<
      "query",
      "internal",
      { conversationKey: string },
      null | {
        activeRunId?: string;
        conversationKey: string;
        lastError?: string;
        position: number;
        threadId?: string;
        watchStopped: boolean;
      },
      Name
    >;
    recordReply: FunctionReference<
      "mutation",
      "internal",
      {
        files: Array<{
          byteSize: number;
          filename: string;
          mimeType: string;
          sha256: string;
          storageId: string;
        }>;
        final?: boolean;
        replyKey: string;
        text: string;
      },
      { ok: boolean; replyId: string },
      Name
    >;
    rotateReplyKey: FunctionReference<
      "mutation",
      "internal",
      { config: string; conversationKey: string; onEvent: string },
      string,
      Name
    >;
    send: FunctionReference<
      "mutation",
      "internal",
      {
        attachments?: Array<{
          byteSize: number;
          filename: string;
          mimeType: string;
          sha256: string;
          url: string;
        }>;
        clientRequestId?: string;
        config: string;
        conversationKey: string;
        launch?: {
          instructions?: string;
          interactionMode?: "default" | "plan";
          modelSelection?: {
            instanceId: string;
            model: string;
            options?: Record<string, string | boolean>;
          };
          projectId: string;
          runtimeMode?: "full-access" | "auto" | "approval-required" | "auto-accept-edits";
          title: string;
          workspaceStrategy?:
            | { branch?: string; type: "root" }
            | {
                baseRef: string;
                branch?: string;
                startFromOrigin?: boolean;
                type: "worktree";
              }
            | {
                branch?: string;
                type: "existing_worktree";
                worktreePath: string;
              };
        };
        onEvent: string;
        text: string;
      },
      string,
      Name
    >;
  };
};
