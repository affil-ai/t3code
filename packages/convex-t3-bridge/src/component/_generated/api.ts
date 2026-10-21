import { anyApi, type ApiFromModules, type FilterApi, type FunctionReference } from "convex/server";
import type * as actions from "../actions.js";
import type * as bridge from "../bridge.js";
import type * as watcher from "../watcher.js";

type FullApi = ApiFromModules<{
  actions: typeof actions;
  bridge: typeof bridge;
  watcher: typeof watcher;
}>;
export const api: FilterApi<
  FullApi,
  FunctionReference<"query" | "mutation" | "action", "public">
> = {
  actions: { importThread: anyApi.actions.importThread, sweep: anyApi.actions.sweep },
  bridge: {
    send: anyApi.bridge.send,
    cancel: anyApi.bridge.cancel,
    rotateReplyKey: anyApi.bridge.rotateReplyKey,
    getConversation: anyApi.bridge.getConversation,
    beginImport: anyApi.bridge.beginImport,
    authorizeReply: anyApi.bridge.authorizeReply,
    recordReply: anyApi.bridge.recordReply,
  },
};
export const internal: FilterApi<
  FullApi,
  FunctionReference<"query" | "mutation" | "action", "internal">
> = {
  actions: {
    deliver: anyApi.actions.deliver,
    watch: anyApi.actions.watch,
    interrupt: anyApi.actions.interrupt,
  },
  bridge: {
    skipCanceled: anyApi.bridge.skipCanceled,
    finishImport: anyApi.bridge.finishImport,
    abortImport: anyApi.bridge.abortImport,
    claimDelivery: anyApi.bridge.claimDelivery,
    deliveryGuard: anyApi.bridge.deliveryGuard,
    acceptDelivery: anyApi.bridge.acceptDelivery,
    deferDelivery: anyApi.bridge.deferDelivery,
    deliveryFailed: anyApi.bridge.deliveryFailed,
  },
  watcher: {
    acquire: anyApi.watcher.acquire,
    renew: anyApi.watcher.renew,
    applyBatch: anyApi.watcher.applyBatch,
    failure: anyApi.watcher.failure,
    sweepPage: anyApi.watcher.sweepPage,
    dueOutbox: anyApi.watcher.dueOutbox,
    claimCancel: anyApi.watcher.claimCancel,
    cancelDone: anyApi.watcher.cancelDone,
    dueCancels: anyApi.watcher.dueCancels,
  },
};
