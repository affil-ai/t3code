import {
  CHAT_BRIDGE_WS_METHODS,
  type ChatBridgeSetSlackSecretInput,
  type ChatBridgeSlackConfig,
} from "@t3tools/contracts";

import type { ChatBridgeService } from "./ChatBridgeService.ts";

export const rpcHandlers = (service: ChatBridgeService["Service"]) => ({
  [CHAT_BRIDGE_WS_METHODS.getStatus]: (_input: Record<string, never>) => service.getStatus(),
  [CHAT_BRIDGE_WS_METHODS.updateSlackConfig]: (input: ChatBridgeSlackConfig) =>
    service.updateSlackConfig(input),
  [CHAT_BRIDGE_WS_METHODS.setSlackSecret]: (input: ChatBridgeSetSlackSecretInput) =>
    service.setSlackSecret(input),
});

/** `rpc.aggregate` span labels, spread into the server's RpcInstrumentation table. */
export const CHAT_BRIDGE_RPC_AGGREGATES = {
  [CHAT_BRIDGE_WS_METHODS.getStatus]: "chatBridge",
  [CHAT_BRIDGE_WS_METHODS.updateSlackConfig]: "chatBridge",
  [CHAT_BRIDGE_WS_METHODS.setSlackSecret]: "chatBridge",
} as const;
