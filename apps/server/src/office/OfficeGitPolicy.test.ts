import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as OfficeService from "./OfficeService.ts";
import * as OfficeGitPolicy from "./OfficeGitPolicy.ts";

const threadId = ThreadId.make("office:git-test");
const messageId = MessageId.make("receipt-vivek");
const entry = {
  threadId,
  officeChatId: "chat",
  workspaceId: "team",
  conversationId: "C123",
  conversationType: "channel" as const,
  label: "Engineering",
};

class TestGitCommandError extends Schema.TaggedError<TestGitCommandError>()("TestGitCommandError", {
  exitCode: Schema.NullOr(Schema.Number),
}) {}

const withRepository = <A, E>(
  test: (input: {
    readonly cwd: string;
    readonly originalHooks: string;
    readonly git: (
      args: ReadonlyArray<string>,
      env?: Readonly<Record<string, string>>,
    ) => Effect.Effect<string, TestGitCommandError | ProcessRunner.ProcessRunError>;
  }) => Effect.Effect<
    A,
    E,
    OfficeService.OfficeService | OfficeGitPolicy.OfficeGitPolicy | SqlClient.SqlClient
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const hostEnvironment = yield* HostProcess.Environment;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-office-git-" });
    const githubBin = path.join(cwd, "broker", "bin");
    const originalHooks = path.join(cwd, ".githooks");
    yield* fs.makeDirectory(githubBin, { recursive: true });
    yield* fs.makeDirectory(originalHooks);
    for (const name of ["gh", "git-credential-office-app"])
      yield* fs.writeFileString(
        path.join(githubBin, name),
        name === "gh" ? "#!/bin/sh\nprintf 'test-installation-token\\n'\n" : "#!/bin/sh\nexit 0\n",
        { mode: 0o700 },
      );
    const git = (args: ReadonlyArray<string>, env?: Readonly<Record<string, string>>) =>
      runner
        .run({
          command: "git",
          args,
          cwd,
          env: {
            ...hostEnvironment,
            ...env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        })
        .pipe(
          Effect.flatMap((result) =>
            result.code === 0
              ? Effect.succeed(result.stdout.trim())
              : Effect.fail(new TestGitCommandError({ exitCode: result.code })),
          ),
        );
    yield* git(["init", "--quiet"]);
    yield* git(["config", "user.name", "Personal User"]);
    yield* git(["config", "user.email", "personal@example.test"]);
    yield* git(["config", "commit.gpgSign", "false"]);
    yield* git(["config", "core.hooksPath", ".githooks"]);
    yield* fs.writeFileString(
      path.join(originalHooks, "prepare-commit-msg"),
      '#!/bin/sh\nprintf "\\nOriginal-Hook: ran\\n" >> "$1"\n',
      { mode: 0o700 },
    );
    yield* fs.writeFileString(
      path.join(originalHooks, "commit-msg"),
      '#!/bin/sh\nsed "/^Co-authored-by:/d" "$1" > "$1.edited"\nmv "$1.edited" "$1"\nprintf "\\nCommit-Hook: ran\\n" >> "$1"\n',
      { mode: 0o700 },
    );
    yield* fs.writeFileString(
      path.join(originalHooks, "pre-commit"),
      '#!/bin/sh\nprintf "ran\\n" >> .pre-commit-ran\n',
      { mode: 0o700 },
    );
    const officeLayer = OfficeService.layer.pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    );
    const policyLayer = OfficeGitPolicy.layer.pipe(
      Layer.provideMerge(officeLayer),
      Layer.provide(ServerConfig.layerTest(cwd, path.join(cwd, "t3-state"))),
    );
    return yield* test({ cwd, originalHooks, git }).pipe(
      Effect.provide(policyLayer),
      Effect.provideService(HostProcess.Environment, {
        ...hostEnvironment,
        T3CODE_OFFICE_GITHUB_BIN: githubBin,
        GIT_CONFIG_COUNT: "0",
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );

describe("Office Git identity", () => {
  it.effect(
    "terminals follow the active actor and child lineage while another request is queued",
    () =>
      withRepository(({ cwd, git }) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const office = yield* OfficeService.OfficeService;
          const policy = yield* OfficeGitPolicy.OfficeGitPolicy;
          yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, payload_json TEXT, deleted_at TEXT)`;
          yield* sql`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, thread_id TEXT, ordinal INTEGER, status TEXT, payload_json TEXT)`;
          yield* office.upsertThread({
            ...entry,
            request: { messageId, requester: { name: "Vivek", email: "vivek@example.test" } },
          });
          const beforeLaunch = yield* policy.environmentForThread({ threadId, cwd });
          expect(beforeLaunch?.OFFICE_GIT_COAUTHOR).toBe("Vivek <vivek@example.test>");
          yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${threadId},${JSON.stringify({ lineage: { rootThreadId: threadId }, activeRunId: "active-run" })},NULL)`;
          yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('active-run',${threadId},1,'running',${JSON.stringify({ userMessageId: messageId })})`;
          yield* office.upsertThread({
            ...entry,
            request: {
              messageId: MessageId.make("queued-request"),
              requester: { name: "Lilly", email: "lilly@example.test" },
            },
          });
          yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('queued-run',${threadId},2,'queued',${JSON.stringify({ userMessageId: "queued-request" })})`;
          expect((yield* policy.environmentForThread({ threadId, cwd }))?.OFFICE_GIT_COAUTHOR).toBe(
            "Vivek <vivek@example.test>",
          );
          const child = ThreadId.make("child");
          yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${child},${JSON.stringify({ lineage: { rootThreadId: threadId }, latestRunId: "active-run" })},NULL)`;
          yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('child-run',${child},1,'running',${JSON.stringify({ userMessageId: messageId })})`;
          expect(
            (yield* policy.environmentForThread({ threadId: child, cwd }))?.OFFICE_GIT_COAUTHOR,
          ).toBe("Vivek <vivek@example.test>");
          expect(
            yield* policy.environmentForThread({ threadId: ThreadId.make("personal"), cwd }),
          ).toBeUndefined();
          const [officeName, personalName] = yield* Effect.all(
            [
              policy.withThreadExecution(
                { threadId, cwd },
                git(["config", "user.name"], { GIT_AUTHOR_NAME: "Caller" }),
              ),
              git(["config", "user.name"]),
            ],
            { concurrency: "unbounded" },
          );
          expect(officeName).toBe("office-of-the-cto[bot]");
          expect(personalName).toBe("Personal User");
          expect(
            yield* policy.withThreadExecution(
              { threadId, cwd },
              GitHubCredentials.ScopedCredential,
            ),
          ).toMatchObject({ source: "gh", host: "github.com" });
          yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${JSON.stringify({ lineage: { rootThreadId: threadId }, worktreePath: cwd })} WHERE thread_id = ${threadId}`;
          const unscoped = yield* policy
            .withThreadExecution({ cwd }, Effect.succeed("must not execute"))
            .pipe(Effect.result);
          expect(unscoped._tag).toBe("Failure");
        }),
      ),
  );
  it.effect("recovers an unregistered server message when the requester is unambiguous", () =>
    withRepository(({ cwd }) =>
      Effect.gen(function* () {
        const office = yield* OfficeService.OfficeService;
        const policy = yield* OfficeGitPolicy.OfficeGitPolicy;
        yield* office.upsertThread({
          ...entry,
          request: { messageId, requester: { name: "Vivek", email: "vivek@example.test" } },
        });
        const generated = MessageId.make("message:server-generated");
        const environment = yield* policy.environmentForMessage({
          threadId,
          messageId: generated,
          cwd,
        });
        expect(environment?.OFFICE_GIT_COAUTHOR).toBe("Vivek <vivek@example.test>");
        yield* office.upsertThread({
          ...entry,
          request: {
            messageId: MessageId.make("message:another-requester"),
            requester: { name: "Lilly", email: "lilly@example.test" },
          },
        });
        const failure = yield* policy
          .environmentForMessage({ threadId, messageId: generated, cwd })
          .pipe(Effect.flip);
        expect(failure.message).toBe("Office request identity is unavailable.");
      }),
    ),
  );
  it.effect(
    "uses the bot with the immutable requester, keeps hooks, and leaves personal commits alone",
    () =>
      withRepository(({ cwd, git }) =>
        Effect.gen(function* () {
          const office = yield* OfficeService.OfficeService;
          const policy = yield* OfficeGitPolicy.OfficeGitPolicy;
          yield* office.upsertThread({
            ...entry,
            request: { messageId, requester: { name: "Vivek", email: "vivek@example.test" } },
          });
          const vivek = yield* policy.environmentForMessage({ threadId, messageId, cwd });
          expect(vivek).toBeDefined();
          expect(
            yield* git(["config", "--get-all", "url.https://github.com/.insteadOf"], vivek),
          ).toBe("git@github.com:\nssh://git@github.com/");
          yield* git(["commit", "--allow-empty", "-m", "Office change"], vivek);
          expect(yield* git(["show", "-s", "--format=%an|%ae|%cn|%ce"])).toBe(
            "office-of-the-cto[bot]|302235476+office-of-the-cto[bot]@users.noreply.github.com|office-of-the-cto[bot]|302235476+office-of-the-cto[bot]@users.noreply.github.com",
          );
          expect(yield* git(["show", "-s", "--format=%B"])).toContain(
            "Co-authored-by: Vivek <vivek@example.test>",
          );
          expect(yield* git(["show", "-s", "--format=%B"])).toContain("Original-Hook: ran");
          expect(yield* git(["show", "-s", "--format=%B"])).toContain("Commit-Hook: ran");
          const second = MessageId.make("receipt-lilly");
          yield* office.upsertThread({
            ...entry,
            request: {
              messageId: second,
              requester: { name: "Lilly", email: "lilly@example.test" },
            },
          });
          const lilly = yield* policy.environmentForMessage({ threadId, messageId: second, cwd });
          yield* git(["commit", "--allow-empty", "--no-verify", "-m", "Lilly change"], lilly);
          expect(yield* git(["show", "-s", "--format=%B"])).toContain(
            "Co-authored-by: Lilly <lilly@example.test>",
          );
          yield* git(["commit", "--allow-empty", "-m", "Earlier agent finishes"], vivek);
          expect(yield* git(["show", "-s", "--format=%B"])).toContain(
            "Co-authored-by: Vivek <vivek@example.test>",
          );
          yield* git(
            [
              "-C",
              cwd,
              "-c",
              "commit.verbose=false",
              "commit",
              "--amend",
              "--allow-empty",
              "--no-verify",
              "--author",
              "Wrong author <wrong@example.test>",
              "-m",
              "Preserve --author text in the message",
            ],
            lilly,
          );
          expect(yield* git(["show", "-s", "--format=%an|%ae"])).toBe(
            "office-of-the-cto[bot]|302235476+office-of-the-cto[bot]@users.noreply.github.com",
          );
          expect(yield* git(["show", "-s", "--format=%B"])).toContain(
            "Preserve --author text in the message",
          );
          expect(yield* git(["show", "-s", "--format=%B"])).toContain(
            "Co-authored-by: Lilly <lilly@example.test>",
          );
          const personal = yield* policy.environmentForMessage({
            threadId: ThreadId.make("personal"),
            messageId,
            cwd,
          });
          expect(personal).toBeUndefined();
          yield* git(["commit", "--allow-empty", "-m", "Personal change"], personal);
          expect(yield* git(["show", "-s", "--format=%an|%ae"])).toBe(
            "Personal User|personal@example.test",
          );
          expect(yield* git(["show", "-s", "--format=%B"])).not.toContain("Co-authored-by:");
          expect(yield* git(["config", "core.hooksPath"])).toBe(".githooks");
          expect(yield* git(["config", "user.name"])).toBe("Personal User");
        }),
      ),
  );

  it.effect("refuses an Office request without an actor before preparing Git", () =>
    withRepository(({ cwd }) =>
      Effect.gen(function* () {
        const policy = yield* OfficeGitPolicy.OfficeGitPolicy;
        const failure = yield* policy
          .environmentForMessage({ threadId, messageId, cwd })
          .pipe(Effect.flip);
        expect(failure.message).toBe("Office request identity is unavailable.");
      }),
    ),
  );
});
