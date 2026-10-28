import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as CodexRpc from "./_generated/meta.gen.ts";
import * as CodexSchema from "./_generated/schema.gen.ts";
import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import {
  decodeNotificationPayload,
  decodeOptionalPayload,
  encodeOptionalPayload,
  runHandler,
} from "./_internal/shared.ts";
import { makeChildStdio, makeStderrDiagnostic, makeTerminationError } from "./_internal/stdio.ts";

export interface CodexAppServerClientOptions {
  /**
   * Fork from the owning scope BEFORE spawning the child so diagnostics close
   * after the spawner has terminated it. Omit for a borrowed process handle.
   */
  readonly diagnosticsScope?: Scope.Scope;
  /** Writes raw stderr to a private file; its contents must never enter a shared log. */
  readonly writeStderrDiagnostic?: (
    pid: number,
    tail: Uint8Array,
  ) => Effect.Effect<string | undefined>;
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (
    event: CodexProtocol.CodexAppServerProtocolLogEvent,
  ) => Effect.Effect<void, never>;
}

interface CodexAppServerClientRaw {
  readonly notifications: CodexProtocol.CodexAppServerPatchedProtocol["incomingNotifications"];
  readonly requests: CodexProtocol.CodexAppServerPatchedProtocol["incomingRequests"];
  readonly request: CodexProtocol.CodexAppServerPatchedProtocol["request"];
  readonly notify: CodexProtocol.CodexAppServerPatchedProtocol["notify"];
  readonly respond: CodexProtocol.CodexAppServerPatchedProtocol["respond"];
  readonly respondError: CodexProtocol.CodexAppServerPatchedProtocol["respondError"];
}

export class CodexAppServerClient extends Context.Service<
  CodexAppServerClient,
  {
    readonly raw: CodexAppServerClientRaw;
    readonly request: <M extends CodexRpc.ClientRequestMethod>(
      method: M,
      payload: CodexRpc.ClientRequestParamsByMethod[M],
    ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexError.CodexAppServerError>;
    readonly notify: <M extends CodexRpc.ClientNotificationMethod>(
      method: M,
      payload: CodexRpc.ClientNotificationParamsByMethod[M],
    ) => Effect.Effect<void, CodexError.CodexAppServerError>;
    readonly handleServerRequest: <M extends CodexRpc.ServerRequestMethod>(
      method: M,
      handler: (
        payload: CodexRpc.ServerRequestParamsByMethod[M],
      ) => Effect.Effect<
        CodexRpc.ServerRequestResponsesByMethod[M],
        CodexError.CodexAppServerError
      >,
    ) => Effect.Effect<void>;
    readonly handleServerNotification: <M extends CodexRpc.ServerNotificationMethod>(
      method: M,
      handler: (
        payload: CodexRpc.ServerNotificationParamsByMethod[M],
      ) => Effect.Effect<void, CodexError.CodexAppServerError>,
    ) => Effect.Effect<void>;
    readonly handleUnknownServerRequest: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<unknown, CodexError.CodexAppServerError>,
    ) => Effect.Effect<void>;
    readonly handleUnknownServerNotification: (
      handler: (
        method: string,
        params: unknown,
      ) => Effect.Effect<void, CodexError.CodexAppServerError>,
    ) => Effect.Effect<void>;
    /** Resolves with the reason once the app-server connection ends, such as the process exiting. */
    readonly terminated: Effect.Effect<CodexError.CodexAppServerError>;
  }
>()("effect-codex-app-server/client/CodexAppServerClient") {}

type ServerRequestHandler = (
  payload: unknown,
) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
type ServerNotificationHandler = (
  payload: unknown,
) => Effect.Effect<void, CodexError.CodexAppServerError>;

const V2TurnStartParamsWithCollaborationMode = CodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(CodexSchema.ClientRequest__CollaborationMode),
    additionalContext: Schema.optionalKey(
      Schema.Record(Schema.String, CodexSchema.V2TurnStartParams__AdditionalContextEntry),
    ),
  }),
);

export const make = Effect.fn("effect-codex-app-server/CodexAppServerClient.make")(function* (
  stdio: Stdio.Stdio,
  options: CodexAppServerClientOptions = {},
  terminationError?: Effect.Effect<CodexError.CodexAppServerError>,
  exited?: Effect.Effect<CodexError.CodexAppServerError>,
): Effect.fn.Return<CodexAppServerClient["Service"], never, Scope.Scope> {
  const requestHandlers = new Map<string, ServerRequestHandler>();
  const notificationHandlers = new Map<string, Array<ServerNotificationHandler>>();
  let unknownRequestHandler:
    | ((method: string, params: unknown) => Effect.Effect<unknown, CodexError.CodexAppServerError>)
    | undefined;
  let unknownNotificationHandler:
    | ((method: string, params: unknown) => Effect.Effect<void, CodexError.CodexAppServerError>)
    | undefined;

  const getServerRequestParamSchema = <M extends CodexRpc.ServerRequestMethod>(
    method: M,
  ):
    | Schema.Codec<CodexRpc.ServerRequestParamsByMethod[M], CodexRpc.ServerRequestParamsByMethod[M]>
    | undefined => CodexRpc.SERVER_REQUEST_PARAMS[method] as never;

  const getServerRequestResponseSchema = <M extends CodexRpc.ServerRequestMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ServerRequestResponsesByMethod[M],
        CodexRpc.ServerRequestResponsesByMethod[M]
      >
    | undefined => CodexRpc.SERVER_REQUEST_RESPONSES[method] as never;

  const getClientRequestParamSchema = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
  ):
    | Schema.Codec<CodexRpc.ClientRequestParamsByMethod[M], CodexRpc.ClientRequestParamsByMethod[M]>
    | undefined =>
    method === "turn/start"
      ? (V2TurnStartParamsWithCollaborationMode as never)
      : (CodexRpc.CLIENT_REQUEST_PARAMS[method] as never);

  const getClientRequestResponseSchema = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ClientRequestResponsesByMethod[M],
        CodexRpc.ClientRequestResponsesByMethod[M]
      >
    | undefined => CodexRpc.CLIENT_REQUEST_RESPONSES[method] as never;

  const getClientNotificationParamSchema = <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
  ):
    | Schema.Codec<
        CodexRpc.ClientNotificationParamsByMethod[M],
        CodexRpc.ClientNotificationParamsByMethod[M]
      >
    | undefined => CodexRpc.CLIENT_NOTIFICATION_PARAMS[method] as never;

  const dispatchNotification = (
    notification: CodexProtocol.CodexAppServerIncomingNotification,
  ): Effect.Effect<void, never> => {
    const schema =
      notification.method in CodexRpc.SERVER_NOTIFICATION_PARAMS
        ? CodexRpc.SERVER_NOTIFICATION_PARAMS[
            notification.method as CodexRpc.ServerNotificationMethod
          ]
        : undefined;
    const handlers = notificationHandlers.get(notification.method) ?? [];

    if (schema) {
      return decodeNotificationPayload(notification.method, schema, notification.params).pipe(
        Effect.flatMap((decoded) =>
          Effect.forEach(handlers, (handler) => handler(decoded), { discard: true }),
        ),
        Effect.ignore,
      );
    }

    return unknownNotificationHandler
      ? unknownNotificationHandler(notification.method, notification.params).pipe(Effect.ignore)
      : Effect.void;
  };

  const dispatchRequest = (
    request: CodexProtocol.CodexAppServerIncomingRequest,
  ): Effect.Effect<unknown, CodexError.CodexAppServerError> => {
    if (request.method in CodexRpc.SERVER_REQUEST_PARAMS) {
      const method = request.method as CodexRpc.ServerRequestMethod;
      const payloadSchema = getServerRequestParamSchema(method);
      const responseSchema = getServerRequestResponseSchema(method);
      const handler = requestHandlers.get(method);

      return decodeOptionalPayload(method, payloadSchema, request.params).pipe(
        Effect.flatMap((decoded) => runHandler(handler, decoded, method)),
        Effect.flatMap((result) => encodeOptionalPayload(method, responseSchema, result)),
      );
    }

    return unknownRequestHandler
      ? unknownRequestHandler(request.method, request.params)
      : Effect.fail(CodexError.CodexAppServerRequestError.methodNotFound(request.method));
  };

  const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
  const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
    stdio,
    onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
    ...(terminationError ? { terminationError } : {}),
    ...(exited ? { exited } : {}),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onNotification: dispatchNotification,
    onRequest: dispatchRequest,
  });

  const request = <M extends CodexRpc.ClientRequestMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ): Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexError.CodexAppServerError> =>
    encodeOptionalPayload(method, getClientRequestParamSchema(method), payload).pipe(
      Effect.flatMap((encoded) => transport.request(method, encoded)),
      Effect.flatMap(
        (
          raw,
        ): Effect.Effect<
          CodexRpc.ClientRequestResponsesByMethod[M],
          CodexError.CodexAppServerError
        > => decodeOptionalPayload(method, getClientRequestResponseSchema(method), raw),
      ),
    );

  const notify = <M extends CodexRpc.ClientNotificationMethod>(
    method: M,
    payload: CodexRpc.ClientNotificationParamsByMethod[M],
  ) =>
    encodeOptionalPayload(method, getClientNotificationParamSchema(method), payload).pipe(
      Effect.flatMap((encoded) => transport.notify(method, encoded)),
    );

  return CodexAppServerClient.of({
    raw: {
      notifications: transport.incomingNotifications,
      requests: transport.incomingRequests,
      request: transport.request,
      notify: transport.notify,
      respond: transport.respond,
      respondError: transport.respondError,
    },
    request,
    notify,
    handleServerRequest: Effect.fn("CodexAppServerClient.handleServerRequest")(
      function (method, handler) {
        return Effect.sync(() => {
          requestHandlers.set(method, handler as ServerRequestHandler);
        });
      },
    ),
    handleServerNotification: Effect.fn("CodexAppServerClient.handleServerNotification")(
      function (method, handler) {
        return Effect.sync(() => {
          const current = notificationHandlers.get(method) ?? [];
          current.push(handler as ServerNotificationHandler);
          notificationHandlers.set(method, current);
        });
      },
    ),
    handleUnknownServerRequest: Effect.fn("CodexAppServerClient.handleUnknownServerRequest")(
      function (handler) {
        return Effect.sync(() => {
          unknownRequestHandler = handler;
        });
      },
    ),
    handleUnknownServerNotification: Effect.fn(
      "CodexAppServerClient.handleUnknownServerNotification",
    )(function (handler) {
      return Effect.sync(() => {
        unknownNotificationHandler = handler;
      });
    }),
    terminated: Deferred.await(termination),
  });
});

export const layerChildProcess = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: CodexAppServerClientOptions = {},
): Layer.Layer<CodexAppServerClient> =>
  Layer.effect(CodexAppServerClient, makeChildProcessClient(handle, options));

const makeChildProcessClient = Effect.fn(
  "effect-codex-app-server/CodexAppServerClient.makeChildProcessClient",
)(function* (handle: ChildProcessSpawner.ChildProcessHandle, options: CodexAppServerClientOptions) {
  const scope = options.diagnosticsScope ?? (yield* Scope.Scope);
  const stderr = makeStderrDiagnostic();
  const stderrDone = yield* Deferred.make<void>();
  yield* Stream.runForEach(handle.stderr, (chunk) => Effect.sync(() => stderr.append(chunk))).pipe(
    Effect.ensuring(Deferred.succeed(stderrDone, undefined)),
    Effect.ignore,
    Effect.forkIn(scope, { startImmediately: true }),
  );
  const reportTermination = (error: CodexError.CodexAppServerError) =>
    Effect.gen(function* () {
      const tail = stderr.read();
      // Disk failures (including defects) and stalled writes must not hold
      // pending RPCs or process recovery, nor log a cause containing stderr.
      const diagnosticPath = options.writeStderrDiagnostic
        ? yield* Effect.suspend(() => options.writeStderrDiagnostic!(handle.pid, tail)).pipe(
            Effect.timeoutOption("1 second"),
            Effect.map(Option.getOrUndefined),
            Effect.catchCause(() => Effect.void),
          )
        : undefined;
      const exitCause =
        error._tag === "CodexAppServerTransportError" && PlatformError.isPlatformError(error.cause)
          ? error.cause.reason.cause
          : undefined;
      // The platform exposes signal exits only through this fixed error.
      // Extract the signal, never forward the error text or command details.
      const signal =
        exitCause instanceof Error
          ? /^Process interrupted due to receipt of signal: '(SIG[A-Z0-9]+)'$/.exec(
              exitCause.message,
            )?.[1]
          : undefined;
      yield* Effect.logWarning("Codex app-server terminated", {
        code: error._tag === "CodexAppServerProcessExitedError" ? error.code : undefined,
        ...(signal === undefined ? {} : { signal }),
        stderrBytes: tail.byteLength,
        diagnosticPath,
      });
    });

  const termination = makeTerminationError(handle).pipe(
    // Wait briefly for the final stderr chunk without allowing diagnostics to
    // wedge process termination when a descendant keeps the pipe open.
    Effect.tap(() =>
      Deferred.await(stderrDone).pipe(Effect.timeoutOption("100 millis"), Effect.asVoid),
    ),
  );
  const terminationError = yield* Effect.cached(termination);
  // Start reporting independently, before protocol disposal can interrupt its
  // only other waiter. The supplied diagnostics scope keeps this waiter alive
  // until the owning process acquisition has finalized.
  const reporter = yield* terminationError.pipe(
    Effect.flatMap(reportTermination),
    Effect.forkIn(scope, { startImmediately: true }),
  );
  yield* Scope.addFinalizer(
    scope,
    // A borrowed or unreferenced process may still be alive. Never wait for its
    // exit before its owner has had a chance to terminate it.
    handle.isRunning.pipe(
      Effect.orElseSucceed(() => true),
      Effect.flatMap((running) => (running ? Effect.void : Fiber.join(reporter))),
    ),
  );
  return yield* make(makeChildStdio(handle), options, terminationError, terminationError);
});
