import type { FunctionHandle } from "convex/server";
import type { Config, T3BridgeEvent } from "../validators.js";

// Function handles are opaque strings created by the host, not function names.
export function isConfigHandle(
  value: string,
): value is FunctionHandle<"query", Record<string, never>, Config> {
  return value.startsWith("function://");
}
export function isEventHandle(
  value: string,
): value is FunctionHandle<"mutation", { event: T3BridgeEvent }, null> {
  return value.startsWith("function://");
}
