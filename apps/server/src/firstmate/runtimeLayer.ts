import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as FirstmateHome from "./FirstmateHome.ts";
import { FirstmateReactor, reactorLayer } from "./FirstmateReactor.ts";
import * as FirstmateService from "./FirstmateService.ts";

/**
 * Starts the reactor and exposes `FirstmateService` to the RPC and MCP layers.
 * Registered on one line in `server.ts`.
 */
export const runtimeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* FirstmateReactor;
    yield* reactor.start();
  }),
).pipe(
  Layer.provideMerge(reactorLayer),
  Layer.provideMerge(FirstmateService.layer),
  Layer.provide(FirstmateHome.layer),
);
