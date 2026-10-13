import { OFFICE_WS_METHODS, type OfficeUpsertThreadInput, type ThreadId } from "@t3tools/contracts";
import type { OfficeService } from "./OfficeService.ts";
import type { StorageCleanup } from "../storageCleanup.ts";
export const rpcHandlers = (
  service: OfficeService["Service"],
  cleanup: StorageCleanup["Service"],
) => ({
  [OFFICE_WS_METHODS.subscribe]: (_input: {}) => service.subscribe(),
  [OFFICE_WS_METHODS.upsertThread]: (input: OfficeUpsertThreadInput) => service.upsertThread(input),
  [OFFICE_WS_METHODS.removeThread]: (input: { readonly threadId: ThreadId }) =>
    service.removeThread(input),
  [OFFICE_WS_METHODS.cleanupWorktree]: (input: { readonly threadId: ThreadId }) =>
    cleanup.releaseThreadWorktree(input.threadId),
});
export const OFFICE_RPC_AGGREGATES = {
  [OFFICE_WS_METHODS.subscribe]: "office",
  [OFFICE_WS_METHODS.upsertThread]: "office",
  [OFFICE_WS_METHODS.removeThread]: "office",
  [OFFICE_WS_METHODS.cleanupWorktree]: "office",
} as const;
