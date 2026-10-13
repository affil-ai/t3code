/**
 * FirstmateHome - the folder Firstmate's coordinator chat runs in, and the T3
 * project rooted there. It holds the agent's instructions (`AGENTS.md`), its
 * memory (`notes/`), and its skills, so the user steers Firstmate by editing
 * files that the provider harness loads on its own.
 *
 * The folder is `~/firstmate`, or `T3CODE_FIRSTMATE_HOME` when set.
 *
 * @module FirstmateHome
 */
import { CommandId, FirstmateError, ProjectId } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  CLAUDE_SKILLS_FALLBACK_README,
  CLAUDE_SKILLS_PATH,
  CLAUDE_SKILLS_TARGET,
  FIRSTMATE_HOME_FILES,
} from "./homeFiles.ts";

export const FIRSTMATE_HOME_ENV = "T3CODE_FIRSTMATE_HOME";
const SEED_COMMIT_MESSAGE = "Add Firstmate home files";
/** Review images live here, outside Git (see the seeded `.gitignore`). */
export const ARTIFACTS_FOLDER = "artifacts";
const FALLBACK_AUTHOR = { name: "Firstmate", email: "firstmate@localhost" };

export class FirstmateHome extends Context.Service<
  FirstmateHome,
  {
    /**
     * Creates the folder and any missing seed file, commits what it added,
     * and finds or creates the project rooted there, titled `name`.
     */
    readonly ensure: (input: {
      readonly name: string;
    }) => Effect.Effect<{ readonly projectId: ProjectId }, FirstmateError>;
    /** Retitles the home project. Does nothing before the project exists. */
    readonly rename: (name: string) => Effect.Effect<void, FirstmateError>;
    /**
     * Copies a review image into `artifacts/<task>/` in the folder and returns
     * the copy's absolute path. A path already in the folder is returned as is.
     */
    readonly keepImage: (input: {
      readonly taskId: string;
      readonly path: string;
    }) => Effect.Effect<string, FirstmateError>;
  }
>()("t3/firstmate/FirstmateHome") {}

/** `T3CODE_FIRSTMATE_HOME` with `~` expanded, else `~/firstmate`. */
export const resolveWorkspaceRoot = Effect.fn("FirstmateHome.resolveWorkspaceRoot")(function* () {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configured = (yield* Config.String(FIRSTMATE_HOME_ENV).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ))?.trim();
  return configured ? path.resolve(expandHomePath(configured, home)) : path.join(home, "firstmate");
});

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const workspaceRoot = yield* resolveWorkspaceRoot();

  const folderError = (cause: unknown) =>
    new FirstmateError({
      message: `Could not set up the Firstmate folder at ${workspaceRoot}.`,
      cause,
    });

  /** Writes `content` unless something is already at `relative`. True when it wrote. */
  const writeIfMissing = (relative: string, content: string) =>
    Effect.gen(function* () {
      const target = path.join(workspaceRoot, relative);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      return yield* fileSystem.writeFileString(target, content, { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
      );
    });

  /**
   * `.claude/skills` links to `.agents/skills`, so Claude Code and Codex share
   * one skills folder. Where links cannot be made, it is a folder of its own.
   * Returns the paths it added.
   */
  const linkClaudeSkills = Effect.gen(function* () {
    const link = path.join(workspaceRoot, CLAUDE_SKILLS_PATH);
    yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
    const linked = yield* fileSystem.symlink(CLAUDE_SKILLS_TARGET, link).pipe(
      Effect.as<"linked" | "present" | "failed">("linked"),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed("present" as const),
      ),
      Effect.orElseSucceed(() => "failed" as const),
    );
    if (linked === "linked") return [CLAUDE_SKILLS_PATH];
    if (linked === "present") return [];
    const readme = `${CLAUDE_SKILLS_PATH}/README.md`;
    return (yield* writeIfMissing(readme, CLAUDE_SKILLS_FALLBACK_README)) ? [readme] : [];
  });

  const seedFiles = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });
    const written: string[] = [];
    for (const file of FIRSTMATE_HOME_FILES) {
      if (yield* writeIfMissing(file.path, file.content)) written.push(file.path);
    }
    written.push(...(yield* linkClaudeSkills));
    return written;
  }).pipe(Effect.mapError(folderError));

  // Git's own identity when it has one, else a fixed Firstmate author.
  const identityEnv = Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    const name = yield* git.readConfigValue(workspaceRoot, "user.name");
    const email = yield* git.readConfigValue(workspaceRoot, "user.email");
    return {
      ...(name !== null || env.GIT_AUTHOR_NAME !== undefined
        ? {}
        : { GIT_AUTHOR_NAME: FALLBACK_AUTHOR.name, GIT_COMMITTER_NAME: FALLBACK_AUTHOR.name }),
      ...(email !== null || env.GIT_AUTHOR_EMAIL !== undefined
        ? {}
        : { GIT_AUTHOR_EMAIL: FALLBACK_AUTHOR.email, GIT_COMMITTER_EMAIL: FALLBACK_AUTHOR.email }),
    };
  });

  /**
   * Makes the folder a repository when it is not one, and commits exactly the
   * seeded paths, so the user's staged work is never swept in. Git trouble
   * (none installed, a signing prompt) leaves the files uncommitted rather
   * than failing the start.
   */
  const commitSeed = (written: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      if (!(yield* fileSystem.exists(path.join(workspaceRoot, ".git")))) {
        const branch =
          (yield* git
            .readConfigValue(workspaceRoot, "init.defaultBranch")
            .pipe(Effect.orElseSucceed(() => null))) ?? "main";
        yield* git.execute({
          operation: "FirstmateHome.init",
          cwd: workspaceRoot,
          args: ["init", `--initial-branch=${branch}`],
          timeoutMs: 10_000,
        });
      }
      if (written.length === 0) return;
      yield* git.execute({
        operation: "FirstmateHome.add",
        cwd: workspaceRoot,
        args: ["add", "--force", "--", ...written],
        timeoutMs: 10_000,
      });
      // A file restored with the content Git already has stages nothing.
      const staged = yield* git.execute({
        operation: "FirstmateHome.diff",
        cwd: workspaceRoot,
        args: ["diff", "--cached", "--quiet", "--", ...written],
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      });
      if (staged.exitCode === 0) return;
      const result = yield* git.execute({
        operation: "FirstmateHome.commit",
        cwd: workspaceRoot,
        args: ["commit", "--message", SEED_COMMIT_MESSAGE, "--", ...written],
        env: yield* identityEnv,
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0) {
        yield* Effect.logWarning("Could not commit the Firstmate home files", {
          stderr: result.stderr.trim(),
        });
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not record the Firstmate home files in Git", { cause }),
      ),
    );

  const ensureProject = (name: string) =>
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4;
      const { project } = yield* projects
        .bootstrap({
          commandId: CommandId.make(`firstmate-home:${id}`),
          projectId: ProjectId.make(id),
          title: name,
          workspaceRoot,
        })
        .pipe(
          // bootstrap looks the root up before taking the workspace lock, so
          // a racing start loses with a conflict that names the winner.
          Effect.catchTags({
            ProjectConflictError: (conflict) =>
              Effect.succeed({ project: { id: conflict.conflictingProjectId } }),
          }),
        );
      return { projectId: project.id };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new FirstmateError({ message: "Could not create the Firstmate project.", cause }),
      ),
    );

  const ensure: FirstmateHome["Service"]["ensure"] = Effect.fn("FirstmateHome.ensure")(
    function* (input) {
      yield* commitSeed(yield* seedFiles);
      return yield* ensureProject(input.name);
    },
  );

  const rename: FirstmateHome["Service"]["rename"] = Effect.fn("FirstmateHome.rename")(
    function* (name) {
      const project = yield* projects
        .getByWorkspaceRoot(workspaceRoot)
        .pipe(Effect.catchTags({ ProjectOperationError: () => Effect.succeedNone }));
      if (Option.isNone(project) || project.value.title === name) return;
      const id = yield* crypto.randomUUIDv4;
      yield* projects.update({
        commandId: CommandId.make(`firstmate-home-rename:${id}`),
        projectId: project.value.id,
        title: name,
      });
    },
    Effect.mapError(
      (cause) => new FirstmateError({ message: "Could not rename the Firstmate project.", cause }),
    ),
  );

  const keepImage: FirstmateHome["Service"]["keepImage"] = Effect.fn("FirstmateHome.keepImage")(
    function* (input) {
      const source = path.resolve(input.path);
      const artifactsRoot = path.join(workspaceRoot, ARTIFACTS_FOLDER);
      if (source.startsWith(`${artifactsRoot}${path.sep}`)) return source;
      // Task ids carry a colon; keep the folder name portable.
      const folder = path.join(artifactsRoot, input.taskId.replace(/[^A-Za-z0-9._-]+/g, "-"));
      yield* fileSystem.makeDirectory(folder, { recursive: true });
      const stamp = (yield* crypto.randomUUIDv4).slice(0, 8);
      const target = path.join(folder, `${stamp}-${path.basename(source)}`);
      yield* fileSystem.copyFile(source, target);
      return target;
    },
    Effect.mapError(
      (cause) => new FirstmateError({ message: "Could not save the review image.", cause }),
    ),
  );

  return FirstmateHome.of({ ensure, rename, keepImage });
});

export const layer = Layer.effect(FirstmateHome, make);
