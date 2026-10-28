import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ChatBindingStore from "./ChatBindingStore.ts";
import * as ChatBridgeConfigStore from "./ChatBridgeConfigStore.ts";
import * as ChatBridgeCore from "./ChatBridgeCore.ts";
import { ChatBridgeService, layer as serviceLayer } from "./ChatBridgeService.ts";
import * as ChatThreadsLive from "./ChatThreadsLive.ts";

/**
 * Starts the bridge and exposes `ChatBridgeService` to the RPC and hook
 * routes. Registered on one line in `server.ts`.
 */
export const runtimeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* ChatBridgeService;
    yield* service.start();
  }),
).pipe(
  Layer.provideMerge(serviceLayer),
  Layer.provide(ChatBridgeCore.layer),
  Layer.provide(Layer.mergeAll(ChatBindingStore.layerSqlite, ChatThreadsLive.layer)),
  Layer.provide(ChatBridgeConfigStore.layerSqlite),
);
