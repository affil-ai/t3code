/**
 * The standup summary the phone widget fetches on its own timeline. It takes
 * the app's normal sign-in (a bearer or browser session) with read scope, so
 * the widget shares the phone's credential instead of holding its own.
 *
 * Registered on one line in `server.ts`.
 *
 * @module standupHttp
 */
import {
  AuthOrchestrationReadScope,
  STANDUP_SUMMARY_PATH,
  StandupSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { FirstmateService } from "./FirstmateService.ts";

const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(StandupSummary));
const noStore = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };

export const standupRouteLayer = HttpRouter.add(
  "GET",
  STANDUP_SUMMARY_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (session._tag === "None") {
      return HttpServerResponse.text("Unauthorized", { status: 401, headers: noStore });
    }
    if (!session.value.scopes.includes(AuthOrchestrationReadScope)) {
      return HttpServerResponse.text("Forbidden", { status: 403, headers: noStore });
    }
    const firstmate = yield* FirstmateService;
    return yield* firstmate.standupSummary().pipe(
      Effect.flatMap(encodeSummary),
      Effect.map((body) =>
        HttpServerResponse.text(body, { contentType: "application/json", headers: noStore }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not serve the standup summary.", { cause }).pipe(
          Effect.as(
            HttpServerResponse.text("Internal Server Error", { status: 500, headers: noStore }),
          ),
        ),
      ),
    );
  }),
);
