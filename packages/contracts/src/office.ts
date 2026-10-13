import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

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
export const OfficeSnapshot = Schema.Struct({ threads: Schema.Array(OfficeThread) });
export type OfficeSnapshot = typeof OfficeSnapshot.Type;
export class OfficeError extends Schema.TaggedError<OfficeError>()("OfficeError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
export const OFFICE_WS_METHODS = {
  subscribe: "office.subscribe",
  upsertThread: "office.upsertThread",
  removeThread: "office.removeThread",
} as const;
export const OFFICE_RPC_REQUIRED_SCOPES = {
  [OFFICE_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [OFFICE_WS_METHODS.upsertThread]: AuthOrchestrationOperateScope,
  [OFFICE_WS_METHODS.removeThread]: AuthOrchestrationOperateScope,
} as const;
export const OFFICE_CLIENT_GUARDED_RPC_SCOPES = {
  [OFFICE_WS_METHODS.upsertThread]: AuthOrchestrationOperateScope,
  [OFFICE_WS_METHODS.removeThread]: AuthOrchestrationOperateScope,
} as const;
const error = Schema.Union([OfficeError, EnvironmentAuthorizationError]);
export const OfficeRpcs = [
  Rpc.make(OFFICE_WS_METHODS.subscribe, {
    payload: Schema.Struct({}),
    success: OfficeSnapshot,
    error,
    stream: true,
  }),
  Rpc.make(OFFICE_WS_METHODS.upsertThread, { payload: OfficeThread, success: Schema.Void, error }),
  Rpc.make(OFFICE_WS_METHODS.removeThread, {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Void,
    error,
  }),
] as const;
