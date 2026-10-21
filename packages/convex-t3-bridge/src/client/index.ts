import {
  createFunctionHandle,
  httpActionGeneric,
  type FunctionArgs,
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type HttpRouter,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import type { Config, T3BridgeEvent } from "../validators.js";
import { handleReplyRequest } from "./reply.js";

export { vT3BridgeEvent } from "../validators.js";
export type { T3BridgeEvent } from "../validators.js";
export type { ComponentApi } from "../component/_generated/component.js";

type MutationContext = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
type QueryContext = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type ActionContext = Pick<GenericActionCtx<GenericDataModel>, "runAction">;
type Options = {
  config: FunctionReference<"query", "internal" | "public", Record<string, never>, Config>;
  onEvent: FunctionReference<"mutation", "internal" | "public", { event: T3BridgeEvent }, unknown>;
};
export type SendArgs = Omit<FunctionArgs<ComponentApi["bridge"]["send"]>, "config" | "onEvent">;

/** Call from host Convex functions. The host owns auth, configuration, and storage. */
export class T3Bridge {
  constructor(
    private readonly component: ComponentApi,
    private readonly options: Options,
  ) {}

  private async handles() {
    return {
      config: await createFunctionHandle(this.options.config),
      onEvent: await createFunctionHandle(this.options.onEvent),
    };
  }
  async send(ctx: MutationContext, args: SendArgs) {
    return ctx.runMutation(this.component.bridge.send, { ...args, ...(await this.handles()) });
  }
  async cancel(ctx: MutationContext, args: { conversationKey: string }) {
    return ctx.runMutation(this.component.bridge.cancel, { ...args, ...(await this.handles()) });
  }
  async importThread(ctx: ActionContext, args: { conversationKey: string; threadId: string }) {
    return ctx.runAction(this.component.actions.importThread, {
      ...args,
      ...(await this.handles()),
    });
  }
  async getConversation(ctx: QueryContext, args: { conversationKey: string }) {
    return ctx.runQuery(this.component.bridge.getConversation, args);
  }
  async rotateReplyKey(ctx: MutationContext, args: { conversationKey: string }) {
    return ctx.runMutation(this.component.bridge.rotateReplyKey, {
      ...args,
      ...(await this.handles()),
    });
  }
  registerReplyRoute(
    http: HttpRouter,
    options: {
      path: string;
      authorize: (request: Request) => boolean | Promise<boolean>;
    },
  ) {
    http.route({
      path: options.path,
      method: "POST",
      handler: httpActionGeneric(async (ctx, request) =>
        handleReplyRequest(ctx, this.component, request, options.authorize),
      ),
    });
  }
}
