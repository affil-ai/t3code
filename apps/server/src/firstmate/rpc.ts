import {
  FIRSTMATE_WS_METHODS,
  type FirstmateGetTaskInput,
  type FirstmateSetCoordinatorInput,
  type FirstmateStartInput,
  type FirstmateSubscribeInput,
} from "@t3tools/contracts";

import type { FirstmateService } from "./FirstmateService.ts";

export const rpcHandlers = (service: FirstmateService["Service"]) => ({
  [FIRSTMATE_WS_METHODS.firstmateSubscribe]: (_input: FirstmateSubscribeInput) =>
    service.subscribe(),
  [FIRSTMATE_WS_METHODS.firstmateGetTask]: (input: FirstmateGetTaskInput) => service.get(input),
  [FIRSTMATE_WS_METHODS.firstmateSetCoordinator]: (input: FirstmateSetCoordinatorInput) =>
    service.setCoordinator(input),
  [FIRSTMATE_WS_METHODS.firstmateStart]: (input: FirstmateStartInput) => service.start(input),
});

/** `rpc.aggregate` span labels, spread into the server's RpcInstrumentation table. */
export const FIRSTMATE_RPC_AGGREGATES = {
  [FIRSTMATE_WS_METHODS.firstmateSubscribe]: "firstmate",
  [FIRSTMATE_WS_METHODS.firstmateGetTask]: "firstmate",
  [FIRSTMATE_WS_METHODS.firstmateSetCoordinator]: "firstmate",
  [FIRSTMATE_WS_METHODS.firstmateStart]: "firstmate",
} as const;
