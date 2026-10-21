/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions from "../actions.js";
import type * as bridge from "../bridge.js";
import type * as crons from "../crons.js";
import type * as events from "../events.js";
import type * as handles from "../handles.js";
import type * as replyKey from "../replyKey.js";
import type * as t3Mcp from "../t3Mcp.js";
import type * as watcher from "../watcher.js";

import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  actions: typeof actions;
  bridge: typeof bridge;
  crons: typeof crons;
  events: typeof events;
  handles: typeof handles;
  replyKey: typeof replyKey;
  t3Mcp: typeof t3Mcp;
  watcher: typeof watcher;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<typeof fullApi, FunctionReference<any, "public">> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
