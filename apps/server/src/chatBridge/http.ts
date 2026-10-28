import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { type ChatBridgeService, SLACK_HOOK_ID } from "./ChatBridgeService.ts";

/**
 * The Slack Events API arrives on the shared `/api/hooks/:hookId/:token`
 * route under a reserved hook id, so T3 Connect's relay forwards it like any
 * scheduled-task hook. None means the route carries on as before.
 */
export const slackHookResponse = Effect.fn("ChatBridge.slackHookResponse")(function* (
  service: ChatBridgeService["Service"],
  input: {
    readonly hookId: string;
    readonly token: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
  },
) {
  if (input.hookId !== SLACK_HOOK_ID) return Option.none<HttpServerResponse.HttpServerResponse>();
  const hasBody = input.method !== "GET" && input.method !== "HEAD";
  const request = new Request(`http://chat-bridge.local/${SLACK_HOOK_ID}`, {
    method: input.method,
    headers: input.headers,
    ...(hasBody ? { body: input.body } : {}),
  });
  const response = yield* service.handleSlackHook(input.token, request);
  return Option.map(response, (web) =>
    HttpServerResponse.fromWeb(web).pipe(
      HttpServerResponse.setHeader("x-t3-hook-outcome", "chat_bridge"),
    ),
  );
});
