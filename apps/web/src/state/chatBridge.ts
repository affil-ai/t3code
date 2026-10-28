import { CHAT_BRIDGE_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const chatBridgeGetStatus = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:chat-bridge:status",
  tag: CHAT_BRIDGE_WS_METHODS.getStatus,
});

export const chatBridgeUpdateSlackConfig = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:chat-bridge:update-slack-config",
  tag: CHAT_BRIDGE_WS_METHODS.updateSlackConfig,
});

export const chatBridgeSetSlackSecret = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:chat-bridge:set-slack-secret",
  tag: CHAT_BRIDGE_WS_METHODS.setSlackSecret,
});
