import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SecretRef, SecretRequestError, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SecretCommands from "./SecretCommands.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-asking");
const tokenRef = SecretRef.make(`secret-ref:${"1".repeat(32)}`);
const passwordRef = SecretRef.make(`secret-ref:${"2".repeat(32)}`);
const token = "tok_live_51Hx9QeZq";
const password = "p@ss w/rd+?&=Zx9";
const values = new Map([
  [tokenRef, token],
  [passwordRef, password],
]);
const node = JSON.stringify(process.execPath);

/** Runs `body` against the service, with refs held by `threadId` and a temp workspace. */
const withService = <A, E>(
  body: (input: {
    readonly commands: SecretCommands.SecretCommands["Service"];
    readonly workspace: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
  options: { readonly stateDir?: string } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-secret-cmd-" });
    yield* fileSystem.makeDirectory(`${workspace}/sub`);
    const layer = SecretCommands.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ProcessRunner.layer,
          Layer.effect(
            ServerConfig.ServerConfig,
            Effect.map(ServerConfig.ServerConfig, (config) => ({
              ...config,
              stateDir: options.stateDir ?? `${workspace}/.state`,
            })),
          ).pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-cmd-cfg-" })),
          ),
          Layer.mock(SecretRequests.SecretRequests)({
            use: (input) => {
              const value = input.threadId === threadId ? values.get(input.ref) : undefined;
              return value === undefined
                ? Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }))
                : Effect.succeed(value);
            },
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({ projectId: "project-1", worktreePath: workspace } as never),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedNone,
          }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const commands = yield* SecretCommands.SecretCommands;
      return yield* body({ commands, workspace });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live("delivers a secret in an environment variable and redacts it from both streams", () =>
  withService(({ commands, workspace }) =>
    Effect.gen(function* () {
      const result = yield* commands.run({
        threadId,
        secrets: [{ secretRef: tokenRef, name: "API_TOKEN" }],
        command: [
          `printf 'raw=%s\\n' "$API_TOKEN"`,
          `printf 'b64=%s\\n' "$(printf %s "$API_TOKEN" | base64)"`,
          `printf 'basic=%s\\n' "$(printf 'bot:%s' "$API_TOKEN" | base64)"`,
          `printf 'len=%s\\n' "\${#API_TOKEN}"`,
          `pwd`,
          `printf 'err=%s' "$API_TOKEN" >&2`,
          `exit 3`,
        ].join("\n"),
      });
      assert.equal(result.exitCode, 3);
      assert.isFalse(result.timedOut);
      assert.notInclude(result.stdout, token);
      assert.notInclude(result.stdout, Buffer.from(token).toString("base64").slice(0, 12));
      assert.include(result.stdout, "raw=[REDACTED]\n");
      assert.include(result.stdout, "b64=[REDACTED]");
      assert.include(result.stdout, `len=${token.length}\n`);
      // The thread's workspace is the default directory.
      assert.include(result.stdout, workspace);
      assert.equal(result.stderr, "err=[REDACTED]");
      assert.isAtLeast(result.redactions, 4);
    }),
  ),
);

it.live("redacts URL, JSON and hex encodings of a value", () =>
  withService(({ commands }) =>
    Effect.gen(function* () {
      const result = yield* commands.run({
        threadId,
        secrets: [{ secretRef: passwordRef, name: "PASSWORD" }],
        command: `${node} -e 'const v = process.env.PASSWORD; console.log(encodeURIComponent(v)); console.log(JSON.stringify({ v })); console.log(Buffer.from(v).toString("hex"))'`,
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, '[REDACTED]\n{"v":"[REDACTED]"}\n[REDACTED]\n');
      assert.equal(result.redactions, 3);
    }),
  ),
);

it.live("delivers a secret on stdin without a trailing newline", () =>
  withService(({ commands }) =>
    Effect.gen(function* () {
      const result = yield* commands.run({
        threadId,
        secrets: [{ secretRef: passwordRef, as: "stdin" }],
        command: `v=$(cat); printf '%s|%s' "\${#v}" "$v"`,
      });
      assert.equal(result.stdout, `${password.length}|[REDACTED]`);
    }),
  ),
);

it.live("delivers a secret in a private file that is deleted afterwards", () =>
  withService(({ commands }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const result = yield* commands.run({
        threadId,
        secrets: [
          { secretRef: passwordRef, as: "file", name: "PASSWORD_FILE" },
          { secretRef: tokenRef, name: "TOKEN" },
        ],
        command: `${node} -e 'const fs = require("fs"), path = require("path"); const file = process.env.PASSWORD_FILE; console.log(file); console.log((fs.statSync(file).mode & 0o777).toString(8), (fs.statSync(path.dirname(file)).mode & 0o777).toString(8)); console.log(fs.readFileSync(file, "utf8") === ${JSON.stringify(password)} ? "match" : "differs")'`,
      });
      assert.equal(result.exitCode, 0, result.stderr);
      const [file, modes, contents] = result.stdout.trim().split("\n");
      assert.equal(modes, "600 700");
      assert.equal(contents, "match");
      assert.isFalse(yield* fileSystem.exists(file!));
    }),
  ),
);

it.live("runs in a directory relative to the workspace", () =>
  withService(({ commands, workspace }) =>
    Effect.gen(function* () {
      const result = yield* commands.run({
        threadId,
        secrets: [{ secretRef: tokenRef, name: "TOKEN" }],
        cwd: "sub",
        command: "pwd",
      });
      assert.equal(result.stdout.trim(), `${workspace}/sub`);
      const missing = yield* commands
        .run({
          threadId,
          secrets: [{ secretRef: tokenRef, name: "TOKEN" }],
          cwd: "missing",
          command: "pwd",
        })
        .pipe(Effect.flip);
      assert.include(missing.message, "is not a directory");
    }),
  ),
);

it.live("refuses another thread's ref, and deliveries that do not fit", () =>
  withService(({ commands }) =>
    Effect.gen(function* () {
      const refused = (input: Omit<Parameters<typeof commands.run>[0], "command">) =>
        commands.run({ ...input, command: "true" }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.include(
        yield* refused({
          threadId: ThreadId.make("thread:delegated-task:child"),
          secrets: [{ secretRef: tokenRef, name: "TOKEN" }],
        }),
        "another thread",
      );
      assert.include(
        yield* refused({
          threadId,
          secrets: [
            { secretRef: tokenRef, as: "stdin" },
            { secretRef: passwordRef, as: "stdin" },
          ],
        }),
        "Only one secret",
      );
      assert.include(
        yield* refused({ threadId, secrets: [{ secretRef: tokenRef }] }),
        "needs a name",
      );
      assert.include(
        yield* refused({
          threadId,
          secrets: [
            { secretRef: tokenRef, name: "X" },
            { secretRef: passwordRef, name: "X" },
          ],
        }),
        "used twice",
      );
    }),
  ),
);

it.live("stops a command at its timeout", () =>
  withService(({ commands }) =>
    Effect.gen(function* () {
      const result = yield* commands.run({
        threadId,
        secrets: [{ secretRef: tokenRef, name: "TOKEN" }],
        command: "sleep 30",
        timeoutMs: 1_000,
      });
      assert.deepInclude(result, { exitCode: null, timedOut: true });
    }),
  ),
);

it.live("never cuts output partway through a value", () =>
  withService(({ commands }) =>
    Effect.gen(function* () {
      // Fills the 1 MiB capture so it ends inside the value, at every offset.
      const filler = 1024 * 1024 - 7;
      const result = yield* commands.run({
        threadId,
        secrets: [{ secretRef: tokenRef, name: "TOKEN" }],
        command: `head -c ${filler} /dev/zero | tr '\\0' x; printf %s "$TOKEN"`,
      });
      assert.isTrue(result.outputTruncated);
      assert.notInclude(result.stdout, token.slice(0, 7));
    }),
  ),
);

it.live("keeps values out of logs and traces", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const logged: Array<string> = [];
    const logger = Logger.make((options) => {
      logged.push(JSON.stringify(options.message), String(options.cause));
    });
    yield* withService(({ commands }) =>
      Effect.gen(function* () {
        yield* commands.run({
          threadId,
          secrets: [{ secretRef: tokenRef, name: "TOKEN" }],
          command: `printf %s "$TOKEN"; printf %s "$TOKEN" >&2; exit 1`,
        });
        yield* commands
          .run({
            threadId,
            secrets: [{ secretRef: tokenRef, name: "TOKEN" }],
            cwd: "/nonexistent-dir",
            command: "true",
          })
          .pipe(Effect.ignore);
      }),
    ).pipe(Effect.withTracer(tracer), Effect.provide(Logger.layer([logger])));
    const recorded = [
      ...logged,
      ...spans.flatMap((span) => [span.name, ...Array.from(span.attributes.values(), String)]),
    ];
    assert.include(recorded, "SecretCommands.run");
    assert.isFalse(recorded.some((entry) => entry.includes(token)));
  }),
);

it.live("kills a command that ignores the stop signal", () =>
  withService(({ commands }) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const result = yield* commands.run({
        threadId,
        secrets: [{ secretRef: tokenRef, name: "TOKEN" }],
        command: "trap '' TERM; while true; do sleep 0.1; done",
        timeoutMs: 1_000,
      });
      assert.deepInclude(result, { exitCode: null, timedOut: true });
      assert.isBelow((yield* Clock.currentTimeMillis) - started, 15_000);
    }),
  ),
);

it.live("does not hand the command the server's Electron and port settings", () =>
  withService(({ commands }) =>
    Effect.gen(function* () {
      process.env.ELECTRON_RUN_AS_NODE = "1";
      const result = yield* commands
        .run({
          threadId,
          secrets: [{ secretRef: tokenRef, name: "TOKEN" }],
          command: 'printf "[%s]" "${ELECTRON_RUN_AS_NODE:-unset}"',
        })
        .pipe(Effect.ensuring(Effect.sync(() => delete process.env.ELECTRON_RUN_AS_NODE)));
      assert.equal(result.stdout, "[unset]");
    }),
  ),
);

it.live("refuses names that change how the shell or loaders run", () =>
  withService(({ commands }) =>
    Effect.gen(function* () {
      for (const name of [
        "BASH_ENV",
        "LD_PRELOAD",
        "PATH",
        "NODE_OPTIONS",
        "DYLD_INSERT_LIBRARIES",
      ]) {
        const refused = yield* commands
          .run({
            threadId,
            secrets: [{ secretRef: tokenRef, as: "file", name }],
            command: "true",
          })
          .pipe(Effect.flip);
        assert.include(refused.message, "changes how commands run");
      }
    }),
  ),
);

it.live("clears private files a crashed run left behind when it starts", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-secret-state-" });
    yield* fileSystem.makeDirectory(`${stateDir}/secret-runs/run-crashed`, { recursive: true });
    yield* fileSystem.writeFileString(`${stateDir}/secret-runs/run-crashed/TOKEN`, token);
    yield* withService(() => Effect.void, { stateDir });
    assert.isFalse(yield* fileSystem.exists(`${stateDir}/secret-runs/run-crashed`));
    assert.equal(
      ((yield* fileSystem.stat(`${stateDir}/secret-runs`)).mode & 0o777).toString(8),
      "700",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
