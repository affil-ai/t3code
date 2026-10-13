import { OfficeError, isOfficeError, type MessageId, type ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Hex from "effect/encoding/Hex";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as OfficeService from "./OfficeService.ts";

export class OfficeGitPolicy extends Context.Service<
  OfficeGitPolicy,
  {
    /** Each result belongs to one message. Never put it in the server's process.env. */
    readonly environmentForMessage: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly cwd: string;
    }) => Effect.Effect<Readonly<Record<string, string>> | undefined, OfficeError>;
  }
>()("t3/office/OfficeGitPolicy") {}

const BOT_NAME = "office-of-the-cto[bot]";
const BOT_EMAIL = "302235476+office-of-the-cto[bot]@users.noreply.github.com";

// prepare-commit-msg also runs with --no-verify. Keep repository hooks, then
// append the requester's trailer with Git's parser instead of rewriting prose.
const prepareCommitMessage = `#!/bin/sh
set -eu
original="$OFFICE_GIT_ORIGINAL_HOOKS/prepare-commit-msg"
if [ -x "$original" ]; then "$original" "$@"; fi
git interpret-trailers --in-place --if-exists addIfDifferent --if-missing add \
  --trailer "Co-authored-by: $OFFICE_GIT_COAUTHOR" "$1"
`;

// A repository's commit-msg hook can edit the trailer after preparation.
// Preserve that hook, then restore the requester on the final message.
const checkCommitMessage = `#!/bin/sh
set -eu
original="$OFFICE_GIT_ORIGINAL_HOOKS/commit-msg"
if [ -x "$original" ]; then "$original" "$@"; fi
git interpret-trailers --in-place --if-exists addIfDifferent --if-missing add \
  --trailer "Co-authored-by: $OFFICE_GIT_COAUTHOR" "$1"
`;

// Git preserves the old author on --amend and lets --author override its
// environment. Apply the bot to ordinary commit commands as well as new commits.
const gitWrapper = `#!/bin/bash
set -eu
args=("$@")
command_index=-1
for ((i=0; i<\${#args[@]}; i++)); do
  case "\${args[i]}" in
    -C|-c|--git-dir|--work-tree|--namespace|--config-env) ((i+=1));;
    --*=*|-*) ;;
    *) command_index=$i; break;;
  esac
done
if [ "$command_index" -lt 0 ] || [ "\${args[command_index]}" != commit ]; then
  exec "$OFFICE_GIT_EXECUTABLE" "$@"
fi
result=("\${args[@]:0:command_index+1}")
for ((i=command_index+1; i<\${#args[@]}; i++)); do
  case "\${args[i]}" in
    --author) ((i+=1));;
    --author=*|--reset-author) ;;
    --)
      result+=("--author=$OFFICE_GIT_BOT_AUTHOR" "\${args[@]:i}")
      exec "$OFFICE_GIT_EXECUTABLE" "\${result[@]}";;
    -m|--message|-F|--file|-C|--reuse-message|-c|--reedit-message|-t|--template|--trailer|--cleanup|--date|--fixup|--squash|--pathspec-from-file)
      result+=("\${args[i]}")
      ((i+=1))
      result+=("\${args[i]}");;
    *) result+=("\${args[i]}");;
  esac
done
exec "$OFFICE_GIT_EXECUTABLE" "\${result[@]}" "--author=$OFFICE_GIT_BOT_AUTHOR"
`;

const quoteShellArgument = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

const make = Effect.gen(function* () {
  const office = yield* OfficeService.OfficeService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const hostEnvironment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const hooksLock = yield* Semaphore.make(1);
  const githubBin =
    hostEnvironment.T3CODE_OFFICE_GITHUB_BIN ??
    path.join(home, ".config", "t3code", "office-github", "bin");
  const runGit = (cwd: string, args: ReadonlyArray<string>) =>
    processRunner
      .run({ command: "git", args, cwd, env: hostEnvironment })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout.trim())
            : Effect.fail(new OfficeError({ message: "Could not prepare Office Git hooks." })),
        ),
      );
  const prepareHooks = Effect.fn("OfficeGitPolicy.prepareHooks")(function* (cwd: string) {
    // --git-path respects a repository's existing core.hooksPath and worktrees.
    const originalHooks = path.resolve(
      cwd,
      yield* runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]),
    );
    const digest = yield* crypto
      .digest(
        "SHA-256",
        new TextEncoder().encode(
          originalHooks + "\0" + prepareCommitMessage + checkCommitMessage + gitWrapper,
        ),
      )
      .pipe(Effect.map(Hex.encode));
    const hooks = path.join(config.stateDir, "office-git", "hooks", digest);
    const gitBin = path.join(config.stateDir, "office-git", "bin", digest);
    yield* fs.makeDirectory(hooks, { recursive: true, mode: 0o700 });
    yield* fs.makeDirectory(gitBin, { recursive: true, mode: 0o700 });
    // Forward all existing hooks, including custom hook runners. The immutable
    // directory key keeps concurrent requests from replacing another repo's hooks.
    const entries = (yield* fs.exists(originalHooks)) ? yield* fs.readDirectory(originalHooks) : [];
    for (const name of entries) {
      if (name === "prepare-commit-msg" || name === "commit-msg") continue;
      const target = path.join(hooks, name);
      const source = path.join(originalHooks, name);
      const existing = yield* fs.readLink(target).pipe(Effect.orElseSucceed(() => null));
      if (existing === source) continue;
      if (yield* fs.exists(target))
        return yield* new OfficeError({ message: "Office Git hook directory changed." });
      yield* fs.symlink(source, target);
    }
    for (const [name, contents] of [
      ["prepare-commit-msg", prepareCommitMessage],
      ["commit-msg", checkCommitMessage],
    ] as const) {
      const hook = path.join(hooks, name);
      const existing = yield* fs.readFileString(hook).pipe(Effect.orElseSucceed(() => null));
      if (existing !== contents) yield* fs.writeFileString(hook, contents, { mode: 0o700 });
    }
    const wrapper = path.join(gitBin, "git");
    if ((yield* fs.readFileString(wrapper).pipe(Effect.orElseSucceed(() => null))) !== gitWrapper)
      yield* fs.writeFileString(wrapper, gitWrapper, { mode: 0o700 });
    return { originalHooks, hooks, gitBin };
  });

  return OfficeGitPolicy.of({
    environmentForMessage: (input) =>
      Effect.gen(function* () {
        const requester = yield* office.requesterForMessage(input);
        if (requester === null) return undefined;
        // A missing broker must fail Office execution before a personal helper can run.
        for (const name of ["gh", "git-credential-office-app"]) {
          if (!(yield* fs.exists(path.join(githubBin, name))))
            return yield* new OfficeError({ message: "Office GitHub access is unavailable." });
        }
        const { originalHooks, hooks, gitBin } = yield* hooksLock.withPermits(1)(
          prepareHooks(input.cwd),
        );
        const values: ReadonlyArray<readonly [string, string]> = [
          ["user.name", BOT_NAME],
          ["user.email", BOT_EMAIL],
          ["user.useConfigOnly", "true"],
          ["commit.gpgSign", "false"],
          ["credential.helper", ""],
          ["credential.https://github.com.helper", ""],
          [
            "credential.https://github.com.helper",
            "!" + quoteShellArgument(path.join(githubBin, "git-credential-office-app")),
          ],
          ["http.https://github.com/.extraheader", ""],
          ["core.hooksPath", hooks],
        ];
        const environment: Record<string, string> = {
          PATH: gitBin + ":" + githubBin + ":" + (hostEnvironment.PATH ?? ""),
          GH_CONFIG_DIR: path.join(githubBin, "..", "config"),
          OFFICE_GITHUB_APP_ENV:
            hostEnvironment.T3CODE_OFFICE_GITHUB_ENV ??
            path.join(githubBin, "..", "github-app.env"),
          GH_TOKEN: "",
          GITHUB_TOKEN: "",
          GIT_AUTHOR_NAME: BOT_NAME,
          GIT_AUTHOR_EMAIL: BOT_EMAIL,
          GIT_COMMITTER_NAME: BOT_NAME,
          GIT_COMMITTER_EMAIL: BOT_EMAIL,
          OFFICE_GIT_COAUTHOR: requester.name + " <" + requester.email + ">",
          OFFICE_GIT_ORIGINAL_HOOKS: originalHooks,
          OFFICE_GIT_EXECUTABLE: hostEnvironment.T3CODE_OFFICE_GIT_EXECUTABLE ?? "/usr/bin/git",
          OFFICE_GIT_BOT_AUTHOR: BOT_NAME + " <" + BOT_EMAIL + ">",
          GIT_CONFIG_COUNT: String(values.length),
          GIT_CONFIG_PARAMETERS: "",
        };
        values.forEach(([key, value], index) => {
          environment["GIT_CONFIG_KEY_" + index] = key;
          environment["GIT_CONFIG_VALUE_" + index] = value;
        });
        return environment;
      }).pipe(
        Effect.mapError((cause) =>
          isOfficeError(cause)
            ? cause
            : new OfficeError({ message: "Could not prepare Office Git identity.", cause }),
        ),
      ),
  });
});

export const layer = Layer.effect(OfficeGitPolicy, make);
