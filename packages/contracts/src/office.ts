import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Organization metadata only. Office retains the conversation in Convex. */
export const OfficeThread = Schema.Struct({
  threadId: ThreadId,
  officeChatId: TrimmedNonEmptyString,
  workspaceId: Schema.NullOr(TrimmedNonEmptyString),
  conversationId: Schema.NullOr(TrimmedNonEmptyString),
  conversationType: Schema.Literals(["channel", "dm", "groupDm", "other"]),
  label: TrimmedNonEmptyString,
});
export type OfficeThread = typeof OfficeThread.Type;
export const OfficeRequester = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128), Schema.isPattern(/^[^\r\n<>]+$/)),
  email: TrimmedNonEmptyString.check(
    Schema.isMaxLength(254),
    Schema.isPattern(/^[^\s<>@]+@[^\s<>@]+$/),
  ),
});
export type OfficeRequester = typeof OfficeRequester.Type;
export const OfficeUpsertThreadInput = Schema.Struct({
  ...OfficeThread.fields,
  request: Schema.Struct({ messageId: MessageId, requester: OfficeRequester }),
});
export type OfficeUpsertThreadInput = typeof OfficeUpsertThreadInput.Type;
export const OfficeSnapshot = Schema.Struct({ threads: Schema.Array(OfficeThread) });
export type OfficeSnapshot = typeof OfficeSnapshot.Type;
export const OfficeWorktreeCleanupOutcome = Schema.Literals([
  "completed",
  "busy",
  "dirty",
  "unpushed",
  "unsafe",
  "retry",
]);
export type OfficeWorktreeCleanupOutcome = typeof OfficeWorktreeCleanupOutcome.Type;
export class OfficeError extends Schema.TaggedError<OfficeError>()("OfficeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
export const isOfficeError = Schema.is(OfficeError);
export const OFFICE_WS_METHODS = {
  subscribe: "office.subscribe",
  upsertThread: "office.upsertThread",
  removeThread: "office.removeThread",
  cleanupWorktree: "office.cleanupWorktree",
} as const;
export const OFFICE_RPC_REQUIRED_SCOPES = {
  [OFFICE_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [OFFICE_WS_METHODS.upsertThread]: AuthOrchestrationOperateScope,
  [OFFICE_WS_METHODS.removeThread]: AuthOrchestrationOperateScope,
  [OFFICE_WS_METHODS.cleanupWorktree]: AuthOrchestrationOperateScope,
} as const;
export const OFFICE_CLIENT_GUARDED_RPC_SCOPES = {
  [OFFICE_WS_METHODS.upsertThread]: AuthOrchestrationOperateScope,
  [OFFICE_WS_METHODS.removeThread]: AuthOrchestrationOperateScope,
  [OFFICE_WS_METHODS.cleanupWorktree]: AuthOrchestrationOperateScope,
} as const;
const error = Schema.Union([OfficeError, EnvironmentAuthorizationError]);
export const OfficeRpcs = [
  Rpc.make(OFFICE_WS_METHODS.subscribe, {
    payload: Schema.Struct({}),
    success: OfficeSnapshot,
    error,
    stream: true,
  }),
  Rpc.make(OFFICE_WS_METHODS.upsertThread, {
    payload: OfficeUpsertThreadInput,
    success: Schema.Void,
    error,
  }),
  Rpc.make(OFFICE_WS_METHODS.removeThread, {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Void,
    error,
  }),
  Rpc.make(OFFICE_WS_METHODS.cleanupWorktree, {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: OfficeWorktreeCleanupOutcome,
    error,
  }),
] as const;
