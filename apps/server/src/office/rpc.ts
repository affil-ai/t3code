import { OFFICE_WS_METHODS, type OfficeThread, type ThreadId } from "@t3tools/contracts";
import type { OfficeService } from "./OfficeService.ts";
export const rpcHandlers = (service: OfficeService["Service"]) => ({
  [OFFICE_WS_METHODS.subscribe]: (_input: {}) => service.subscribe(),
  [OFFICE_WS_METHODS.upsertThread]: (input: OfficeThread) => service.upsertThread(input),
  [OFFICE_WS_METHODS.removeThread]: (input: { readonly threadId: ThreadId }) =>
    service.removeThread(input),
});
export const OFFICE_RPC_AGGREGATES = {
  [OFFICE_WS_METHODS.subscribe]: "office",
  [OFFICE_WS_METHODS.upsertThread]: "office",
  [OFFICE_WS_METHODS.removeThread]: "office",
} as const;
