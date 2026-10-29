/**
 * FirstmateHome - the agents repository and the folder each agent's
 * coordinator chat runs in. The repository (`~/agents`, or
 * `T3CODE_AGENTS_HOME`) holds the instructions, memory, and skills shared by
 * every agent; `crew/<slug>/` holds one agent's own, and is the root of the
 * T3 project its chat runs in. The provider harness loads the shared files and
 * the agent's own on its own, so the user steers agents by editing files.
 *
 * Firstmate's folder from before agents existed (`~/firstmate`, or
 * `T3CODE_FIRSTMATE_HOME`) moves into the repository once, keeping its history.
 * Agents' folders were under `agents/`, which read as `~/agents/agents/<slug>`;
 * they move to `crew/` once.
 *
 * @module FirstmateHome
 */
import {
  CommandId,
  FirstmateError,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerConfig from "../config.ts";
import { planAttachmentClaim } from "../attachmentStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  agentHomeFiles,
  CLAUDE_SKILLS_FALLBACK_README,
  CLAUDE_SKILLS_PATH,
  CLAUDE_SKILLS_TARGET,
  ROLE_END,
  ROLE_START,
  roleBlock,
  SHARED_HOME_FILES,
} from "./homeFiles.ts";

const AGENTS_HOME_ENV = "T3CODE_AGENTS_HOME";
/** Where Firstmate lived before the shared repository. Read only to move it. */
const FIRSTMATE_HOME_ENV = "T3CODE_FIRSTMATE_HOME";
/** Agents' folders live under this, inside the repository. */
const CREW_FOLDER = "crew";
/** Where agents' folders lived before `crew/`. Read only to move them. */
const LEGACY_AGENTS_FOLDER = "agents";
/** Review images live here, outside Git (see the seeded `.gitignore`). */
export const ARTIFACTS_FOLDER = "artifacts";
const FALLBACK_AUTHOR = { name: "Firstmate", email: "firstmate@localhost" };
const isFirstmateError = Schema.is(FirstmateError);

export class FirstmateHome extends Context.Service<
  FirstmateHome,
  {
    /** The repository's `artifacts/` folder, where kept review images live. */
    readonly artifactsRoot: string;
    /**
     * Creates the repository and the agent's folder with any missing seed
     * file, commits what it added, and finds or creates the project rooted at
     * the agent's folder, titled `name`.
     */
    readonly ensure: (input: {
      readonly slug: string;
      readonly name: string;
      readonly role: string;
    }) => Effect.Effect<{ readonly projectId: ProjectId }, FirstmateError>;
    /** Retitles the agent's project. Does nothing before the project exists. */
    readonly rename: (input: {
      readonly slug: string;
      readonly name: string;
    }) => Effect.Effect<void, FirstmateError>;
    /** Replaces the role at the top of the agent's `AGENTS.md`, and commits it. */
    readonly writeRole: (input: {
      readonly slug: string;
      readonly name: string;
      readonly role: string;
    }) => Effect.Effect<void, FirstmateError>;
    /**
     * Copies a review image into `artifacts/<task>/` in the repository and
     * returns the copy's absolute path. A path already there is returned as is.
     */
    readonly keepImage: (input: {
      readonly taskId: string;
      readonly path: string;
    }) => Effect.Effect<string, FirstmateError>;
    /** Copies an uploaded image into a durable, agent-owned attachment. */
    readonly keepAvatar: (input: {
      readonly agentId: string;
      readonly attachmentId: string;
    }) => Effect.Effect<string, FirstmateError>;
    /**
     * Moves a pre-agents `~/firstmate` into `crew/firstmate`, keeping its
     * Git history as the repository's, and repoints Firstmate's project.
     * Returns the old and new folder when it moved something, else null.
     */
    readonly migrateLegacyHome: () => Effect.Effect<
      { readonly from: string; readonly to: string } | null,
      FirstmateError
    >;
    /**
     * Moves each agent's folder from `agents/<slug>` to `crew/<slug>` in one
     * commit, and repoints each agent's project. Returns the folders it moved.
     */
    readonly migrateAgentsFolder: () => Effect.Effect<
      ReadonlyArray<{ readonly from: string; readonly to: string }>,
      FirstmateError
    >;
  }
>()("t3/firstmate/FirstmateHome") {}

const configuredPath = Effect.fn("FirstmateHome.configuredPath")(function* (name: string) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configured = (yield* Config.String(name).pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ))?.trim();
  return configured ? path.resolve(expandHomePath(configured, home)) : null;
});

/** `T3CODE_AGENTS_HOME` with `~` expanded, else `~/agents`. */
const resolveRepoRoot = Effect.fn("FirstmateHome.resolveRepoRoot")(function* () {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  return (yield* configuredPath(AGENTS_HOME_ENV)) ?? path.join(home, "agents");
});

/** Firstmate's pre-agents folder: `T3CODE_FIRSTMATE_HOME` with `~` expanded, else `~/firstmate`. */
const resolveLegacyRoot = Effect.fn("FirstmateHome.resolveLegacyRoot")(function* () {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  return (yield* configuredPath(FIRSTMATE_HOME_ENV)) ?? path.join(home, "firstmate");
});

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const repoRoot = yield* resolveRepoRoot();
  const legacyRoot = yield* resolveLegacyRoot();
  const agentFolder = (slug: string) => path.join(repoRoot, CREW_FOLDER, slug);

  const folderError = (what: string) => (cause: unknown) =>
    new FirstmateError({ message: `Could not set up ${what} at ${repoRoot}.`, cause });

  /** Writes `content` unless something is already at `absolute`. True when it wrote. */
  const writeIfMissing = Effect.fn("FirstmateHome.writeIfMissing")(function* (
    absolute: string,
    content: string,
  ) {
    yield* fileSystem.makeDirectory(path.dirname(absolute), { recursive: true });
    return yield* fileSystem.writeFileString(absolute, content, { flag: "wx" }).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
    );
  });

  /**
   * `.claude/skills` links to `.agents/skills` in `folder`, so Claude Code and
   * Codex share one skills folder. Where links cannot be made, it is a folder
   * of its own. Returns the repository-relative paths it added.
   */
  const linkClaudeSkills = Effect.fn("FirstmateHome.linkClaudeSkills")(function* (folder: string) {
    const link = path.join(folder, CLAUDE_SKILLS_PATH);
    yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
    const linked = yield* fileSystem.symlink(CLAUDE_SKILLS_TARGET, link).pipe(
      Effect.as<"linked" | "present" | "failed">("linked"),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed("present" as const),
      ),
      Effect.orElseSucceed(() => "failed" as const),
    );
    if (linked === "linked") return [path.relative(repoRoot, link)];
    if (linked === "present") return [];
    const readme = path.join(link, "README.md");
    return (yield* writeIfMissing(readme, CLAUDE_SKILLS_FALLBACK_README))
      ? [path.relative(repoRoot, readme)]
      : [];
  });

  const seedFolder = Effect.fn("FirstmateHome.seedFolder")(function* (
    folder: string,
    files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
  ) {
    yield* fileSystem.makeDirectory(folder, { recursive: true });
    const written: string[] = [];
    for (const file of files) {
      const absolute = path.join(folder, file.path);
      if (yield* writeIfMissing(absolute, file.content))
        written.push(path.relative(repoRoot, absolute));
    }
    written.push(...(yield* linkClaudeSkills(folder)));
    return written;
  });

  // Git's own identity when it has one, else a fixed author.
  const identityEnv = Effect.gen(function* () {
    const env = yield* HostProcess.Environment;
    const name = yield* git.readConfigValue(repoRoot, "user.name");
    const email = yield* git.readConfigValue(repoRoot, "user.email");
    return {
      ...(name !== null || env.GIT_AUTHOR_NAME !== undefined
        ? {}
        : { GIT_AUTHOR_NAME: FALLBACK_AUTHOR.name, GIT_COMMITTER_NAME: FALLBACK_AUTHOR.name }),
      ...(email !== null || env.GIT_AUTHOR_EMAIL !== undefined
        ? {}
        : { GIT_AUTHOR_EMAIL: FALLBACK_AUTHOR.email, GIT_COMMITTER_EMAIL: FALLBACK_AUTHOR.email }),
    };
  });

  const ensureRepository = Effect.gen(function* () {
    if (yield* fileSystem.exists(path.join(repoRoot, ".git"))) return;
    const branch =
      (yield* git
        .readConfigValue(repoRoot, "init.defaultBranch")
        .pipe(Effect.orElseSucceed(() => null))) ?? "main";
    yield* git.execute({
      operation: "FirstmateHome.init",
      cwd: repoRoot,
      args: ["init", `--initial-branch=${branch}`],
      timeoutMs: 10_000,
    });
  });

  /**
   * Makes the repository when it is not one, and commits exactly `paths`, so
   * the user's staged work is never swept in. Git trouble (none installed, a
   * signing prompt) leaves the files uncommitted rather than failing the start.
   */
  const commitPaths = Effect.fn("FirstmateHome.commitPaths")(
    function* (paths: ReadonlyArray<string>, message: string) {
      yield* ensureRepository;
      if (paths.length === 0) return;
      yield* git.execute({
        operation: "FirstmateHome.add",
        cwd: repoRoot,
        args: ["add", "--all", "--force", "--", ...paths],
        timeoutMs: 10_000,
      });
      // A file restored with the content Git already has stages nothing.
      const staged = yield* git.execute({
        operation: "FirstmateHome.diff",
        cwd: repoRoot,
        args: ["diff", "--cached", "--quiet", "--", ...paths],
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      });
      if (staged.exitCode === 0) return;
      const result = yield* git.execute({
        operation: "FirstmateHome.commit",
        cwd: repoRoot,
        args: ["commit", "--message", message, "--", ...paths],
        env: yield* identityEnv,
        allowNonZeroExit: true,
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0) {
        yield* Effect.logWarning("Could not commit the agents home files", {
          stderr: result.stderr.trim(),
        });
      }
    },
    Effect.catch((cause) =>
      Effect.logWarning("Could not record the agents home files in Git", { cause }),
    ),
  );

  const ensureProject = Effect.fn("FirstmateHome.ensureProject")(
    function* (folder: string, name: string) {
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const { project } = yield* projects
        .bootstrap({
          commandId: CommandId.make(`firstmate-home:${id}`),
          projectId: ProjectId.make(id),
          title: name,
          workspaceRoot: folder,
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
    },
    Effect.mapError(
      (cause) => new FirstmateError({ message: "Could not create the agent's project.", cause }),
    ),
  );

  const ensure: FirstmateHome["Service"]["ensure"] = Effect.fn("FirstmateHome.ensure")(
    function* (input) {
      const folder = agentFolder(input.slug);
      const written = [
        ...(yield* seedFolder(repoRoot, SHARED_HOME_FILES)),
        ...(yield* seedFolder(folder, agentHomeFiles(input.name, input.role))),
      ].filter((relative, index, all) => all.indexOf(relative) === index);
      yield* commitPaths(written, `Add home files for ${input.name}`).pipe(
        Effect.mapError(folderError("the agents repository")),
      );
      return yield* ensureProject(folder, input.name);
    },
    Effect.mapError((cause) =>
      isFirstmateError(cause) ? cause : folderError("the agent's folder")(cause),
    ),
  );

  const rename: FirstmateHome["Service"]["rename"] = Effect.fn("FirstmateHome.rename")(
    function* (input) {
      const project = yield* projects
        .getByWorkspaceRoot(agentFolder(input.slug))
        .pipe(Effect.catchTags({ ProjectOperationError: () => Effect.succeedNone }));
      if (Option.isNone(project) || project.value.title === input.name) return;
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      yield* projects.update({
        commandId: CommandId.make(`firstmate-home-rename:${id}`),
        projectId: project.value.id,
        title: input.name,
      });
    },
    Effect.mapError(
      (cause) => new FirstmateError({ message: "Could not rename the agent's project.", cause }),
    ),
  );

  const writeRole: FirstmateHome["Service"]["writeRole"] = Effect.fn("FirstmateHome.writeRole")(
    function* (input) {
      const file = path.join(agentFolder(input.slug), "AGENTS.md");
      const current = yield* fileSystem
        .readFileString(file)
        .pipe(Effect.orElseSucceed(() => `# ${input.name}\n`));
      const start = current.indexOf(ROLE_START);
      const end = current.indexOf(ROLE_END);
      let next: string;
      if (start !== -1 && end > start) {
        next = `${current.slice(0, start)}${roleBlock(input.role)}${current.slice(end + ROLE_END.length)}`;
      } else {
        // No markers yet (a folder from before roles): put the role under the title.
        const lines = current.split("\n");
        const title = lines.findIndex((line) => line.startsWith("# "));
        lines.splice(title + 1, 0, "", roleBlock(input.role));
        next = lines.join("\n");
      }
      if (next === current) return;
      yield* fileSystem.writeFileString(file, next);
      yield* commitPaths([path.relative(repoRoot, file)], `Update ${input.name}'s role`);
    },
    Effect.mapError(
      (cause) => new FirstmateError({ message: "Could not write the agent's role.", cause }),
    ),
  );

  const keepImage: FirstmateHome["Service"]["keepImage"] = Effect.fn("FirstmateHome.keepImage")(
    function* (input) {
      const source = path.resolve(input.path);
      const artifactsRoot = path.join(repoRoot, ARTIFACTS_FOLDER);
      if (source.startsWith(`${artifactsRoot}${path.sep}`)) return source;
      // Task ids carry a colon; keep the folder name portable.
      const folder = path.join(artifactsRoot, input.taskId.replace(/[^A-Za-z0-9._-]+/g, "-"));
      yield* fileSystem.makeDirectory(folder, { recursive: true });
      const stamp = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8);
      const target = path.join(folder, `${stamp}-${path.basename(source)}`);
      yield* fileSystem.copyFile(source, target);
      return target;
    },
    Effect.mapError(
      (cause) => new FirstmateError({ message: "Could not save the review image.", cause }),
    ),
  );

  /**
   * `~/firstmate` becomes `crew/firstmate` in the repository. Its `.git`
   * moves up to the repository root, so Firstmate's history is the
   * repository's, and the move is one commit Git shows as renames. A copy of
   * the old folder is kept beside it until the user deletes it.
   */
  const migrateLegacyHome: FirstmateHome["Service"]["migrateLegacyHome"] = Effect.fn(
    "FirstmateHome.migrateLegacyHome",
  )(
    function* () {
      const target = agentFolder("firstmate");
      if (legacyRoot === repoRoot || legacyRoot.startsWith(`${repoRoot}${path.sep}`)) return null;
      if (!(yield* fileSystem.exists(legacyRoot))) return null;
      if (yield* fileSystem.exists(target)) return null;
      const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
      const backup = `${legacyRoot}.bak-${stamp}`;
      yield* Effect.logInfo("Moving the Firstmate folder into the agents repository", {
        from: legacyRoot,
        to: target,
        backup,
      });
      // Looked up before the move: the root must exist for the lookup to resolve it.
      const project = yield* projects
        .getByWorkspaceRoot(legacyRoot)
        .pipe(Effect.catchTags({ ProjectOperationError: () => Effect.succeedNone }));
      yield* fileSystem.copy(legacyRoot, backup, { preserveTimestamps: true });
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.rename(legacyRoot, target);
      // Review images kept under the old folder follow it; new ones go to the root.
      const movedArtifacts = path.join(target, ARTIFACTS_FOLDER);
      if (yield* fileSystem.exists(movedArtifacts)) {
        const rootArtifacts = path.join(repoRoot, ARTIFACTS_FOLDER);
        if (!(yield* fileSystem.exists(rootArtifacts))) {
          yield* fileSystem.rename(movedArtifacts, rootArtifacts);
        }
      }
      const movedGit = path.join(target, ".git");
      if (
        (yield* fileSystem.exists(movedGit)) &&
        !(yield* fileSystem.exists(path.join(repoRoot, ".git")))
      ) {
        yield* fileSystem.rename(movedGit, path.join(repoRoot, ".git"));
        // Stage the whole tree as it stands now: the old root paths are gone and
        // the same files sit under crew/firstmate, which Git records as renames.
        yield* git.execute({
          operation: "FirstmateHome.moveAdd",
          cwd: repoRoot,
          args: ["add", "--all", "--", "."],
          timeoutMs: 30_000,
        });
        const result = yield* git.execute({
          operation: "FirstmateHome.moveCommit",
          cwd: repoRoot,
          args: ["commit", "--message", "Move Firstmate into crew/firstmate"],
          env: yield* identityEnv,
          allowNonZeroExit: true,
          timeoutMs: 30_000,
        });
        if (result.exitCode !== 0) {
          yield* Effect.logWarning("Could not commit the Firstmate move", {
            stderr: result.stderr.trim(),
          });
        }
      }
      // The repository's shared files, now that Firstmate's folder is below them.
      const shared = yield* seedFolder(repoRoot, SHARED_HOME_FILES);
      yield* commitPaths(shared, "Add the shared agents home files");
      // Firstmate's chat keeps its project; the project follows the folder.
      if (Option.isSome(project)) {
        const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        yield* projects.update({
          commandId: CommandId.make(`firstmate-home-move:${id}`),
          projectId: project.value.id,
          workspaceRoot: target,
        });
      }
      return { from: legacyRoot, to: target };
    },
    Effect.mapError(
      (cause) =>
        new FirstmateError({
          message: `Could not move the Firstmate folder from ${legacyRoot} into ${repoRoot}.`,
          cause,
        }),
    ),
  );

  /**
   * `agents/<slug>` becomes `crew/<slug>`. Only the moved folders are staged, as
   * one commit Git shows as renames; an agent whose `crew/` folder already
   * exists is left where it is.
   */
  const migrateAgentsFolder: FirstmateHome["Service"]["migrateAgentsFolder"] = Effect.fn(
    "FirstmateHome.migrateAgentsFolder",
  )(
    function* () {
      const legacyFolder = path.join(repoRoot, LEGACY_AGENTS_FOLDER);
      if (!(yield* fileSystem.exists(legacyFolder))) return [];
      if ((yield* fileSystem.stat(legacyFolder)).type !== "Directory") return [];
      const moved: Array<{ readonly from: string; readonly to: string }> = [];
      for (const slug of yield* fileSystem.readDirectory(legacyFolder)) {
        const from = path.join(legacyFolder, slug);
        const to = agentFolder(slug);
        if ((yield* fileSystem.stat(from)).type !== "Directory") continue;
        if (yield* fileSystem.exists(to)) continue;
        // Looked up before the move: the root must exist for the lookup to resolve it.
        const project = yield* projects
          .getByWorkspaceRoot(from)
          .pipe(Effect.catchTags({ ProjectOperationError: () => Effect.succeedNone }));
        yield* Effect.logInfo("Moving an agent's folder into crew/", { from, to });
        yield* fileSystem.makeDirectory(path.dirname(to), { recursive: true });
        yield* fileSystem.rename(from, to);
        if (Option.isSome(project)) {
          const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          yield* projects.update({
            commandId: CommandId.make(`firstmate-home-crew:${id}`),
            projectId: project.value.id,
            workspaceRoot: to,
          });
        }
        moved.push({ from, to });
      }
      // Checked empty first, so the recursive remove takes only the folder itself.
      if ((yield* fileSystem.readDirectory(legacyFolder)).length === 0) {
        yield* fileSystem.remove(legacyFolder, { recursive: true });
      }
      if (moved.length === 0 || !(yield* fileSystem.exists(path.join(repoRoot, ".git")))) {
        return moved;
      }
      const paths = moved.flatMap(({ from, to }) => [
        path.relative(repoRoot, from),
        path.relative(repoRoot, to),
      ]);
      yield* git
        .execute({
          operation: "FirstmateHome.crewAdd",
          cwd: repoRoot,
          args: ["add", "--all", "--", ...paths],
          timeoutMs: 30_000,
        })
        .pipe(
          Effect.andThen(
            git.execute({
              operation: "FirstmateHome.crewCommit",
              cwd: repoRoot,
              args: ["commit", "--message", "Move agents' folders into crew/", "--", ...paths],
              env: yield* identityEnv,
              allowNonZeroExit: true,
              timeoutMs: 30_000,
            }),
          ),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.logWarning("Could not commit the move into crew/", {
                  stderr: result.stderr.trim(),
                }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Could not record the move into crew/ in Git", { cause }),
          ),
        );
      return moved;
    },
    Effect.mapError(
      (cause) =>
        new FirstmateError({
          message: `Could not move the agents' folders into ${path.join(repoRoot, CREW_FOLDER)}.`,
          cause,
        }),
    ),
  );

  const keepAvatar: FirstmateHome["Service"]["keepAvatar"] = Effect.fn("FirstmateHome.keepAvatar")(
    function* (input) {
      const claim = planAttachmentClaim({
        attachmentsDir: config.attachmentsDir,
        threadId: `avatar-${input.agentId}`,
        attachmentId: input.attachmentId,
      });
      if (
        !claim.ok ||
        ![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(
          path.extname(claim.currentPath).toLowerCase(),
        )
      ) {
        return yield* new FirstmateError({
          message: "Choose an uploaded PNG, JPEG, GIF, or WebP image.",
        });
      }
      const stat = yield* fileSystem.stat(claim.currentPath);
      if (
        stat.type !== "File" ||
        stat.size <= 0n ||
        stat.size > BigInt(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
      ) {
        return yield* new FirstmateError({
          message: "The avatar must be an image of at most 10 MB.",
        });
      }
      // Use the stored bytes, not client MIME metadata, before retaining an upload.
      if (readImageDimensions(yield* fileSystem.readFile(claim.currentPath)) === null) {
        return yield* new FirstmateError({
          message: "The avatar upload is not a supported image.",
        });
      }
      yield* fileSystem.copyFile(claim.currentPath, claim.finalPath);
      return claim.finalId;
    },
    Effect.mapError((cause) =>
      isFirstmateError(cause)
        ? cause
        : new FirstmateError({ message: "Could not store the agent avatar.", cause }),
    ),
  );

  return FirstmateHome.of({
    artifactsRoot: path.join(repoRoot, ARTIFACTS_FOLDER),
    ensure,
    rename,
    writeRole,
    keepImage,
    keepAvatar,
    migrateLegacyHome,
    migrateAgentsFolder,
  });
});

export const layer = Layer.effect(FirstmateHome, make);
