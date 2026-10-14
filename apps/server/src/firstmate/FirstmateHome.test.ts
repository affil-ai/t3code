import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as FirstmateHome from "./FirstmateHome.ts";
import { agentHomeFiles, SHARED_HOME_FILES } from "./homeFiles.ts";

const layerEnrichment = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

/** The service over a real ProjectService and real git, with `env` as its config. */
const layer = (baseDir: string, env: Record<string, string>) =>
  FirstmateHome.layer.pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(layerEnrichment),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Layer.provideMerge(NodeServices.layer),
  );

/**
 * Runs `body` with a fresh temp folder as the user's home directory, and git
 * reading an empty global config so the developer's identity stays out.
 */
const withHome = <A, E>(
  body: (input: {
    readonly homeDir: string;
  }) => Effect.Effect<
    A,
    E,
    FirstmateHome.FirstmateHome | ProjectService.ProjectService | NodeServices.NodeServices
  >,
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-firstmate-home-" });
    const emptyConfig = path.join(homeDir, ".gitconfig");
    yield* fileSystem.writeFileString(emptyConfig, "");
    const saved = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_NOSYSTEM,
    };
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        process.env.GIT_CONFIG_GLOBAL = emptyConfig;
        process.env.GIT_CONFIG_NOSYSTEM = "1";
      }),
      () =>
        body({ homeDir }).pipe(
          Effect.provide(layer(path.join(homeDir, ".t3"), env)),
          Effect.provideService(HostProcess.HomeDirectory, homeDir),
        ),
      () =>
        Effect.sync(() => {
          if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
          else process.env.GIT_CONFIG_GLOBAL = saved.global;
          if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
          else process.env.GIT_CONFIG_NOSYSTEM = saved.system;
        }),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const gitOutput = (cwd: string, args: ReadonlyArray<string>) =>
  ProcessRunner.ProcessRunner.pipe(
    Effect.flatMap((runner) => runner.run({ command: "git", args: ["-C", cwd, ...args] })),
    Effect.map((result) => result.stdout.trim()),
    Effect.provide(ProcessRunner.layer),
  );

const firstmate = { slug: "firstmate", name: "Firstmate", role: "" };

it.effect("seeds ~/agents as one committed repository with the agent's folder, and registers it as a project", () =>
  withHome(({ homeDir }) =>
    Effect.gen(function* () {
      const home = yield* FirstmateHome.FirstmateHome;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = path.join(homeDir, "agents");
      const folder = path.join(repo, "agents", "jarvis");

      const { projectId } = yield* home.ensure({
        slug: "jarvis",
        name: "Jarvis",
        role: "You run the growth team.",
      });

      for (const file of SHARED_HOME_FILES) {
        assert.equal(yield* fileSystem.readFileString(path.join(repo, file.path)), file.content);
      }
      for (const file of agentHomeFiles("Jarvis", "You run the growth team.")) {
        assert.equal(yield* fileSystem.readFileString(path.join(folder, file.path)), file.content);
      }
      assert.include(
        yield* fileSystem.readFileString(path.join(folder, "AGENTS.md")),
        "You run the growth team.",
      );
      assert.equal(yield* fileSystem.readFileString(path.join(folder, "CLAUDE.md")), "@AGENTS.md\n");
      for (const base of [repo, folder]) {
        assert.equal(
          yield* fileSystem.readLink(path.join(base, ".claude", "skills")),
          "../.agents/skills",
        );
        assert.isTrue(yield* fileSystem.exists(path.join(base, ".claude", "skills", "README.md")));
      }
      assert.isFalse(yield* fileSystem.exists(path.join(folder, ".git")));

      assert.equal(
        yield* gitOutput(repo, ["log", "--format=%s|%an <%ae>"]),
        "Add home files for Jarvis|Firstmate <firstmate@localhost>",
      );
      assert.equal(yield* gitOutput(repo, ["status", "--porcelain"]), "");

      const project = Option.getOrThrow(yield* projects.getById(projectId));
      assert.equal(project.title, "Jarvis");
      assert.equal(project.workspaceRoot, folder);
    }),
  ),
);

it.effect("keeps the user's edits and reuses the project on a second start", () =>
  withHome(({ homeDir }) =>
    Effect.gen(function* () {
      const home = yield* FirstmateHome.FirstmateHome;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repo = path.join(homeDir, "agents");
      const root = path.join(repo, "agents", "firstmate");
      // A folder the user already started, with their own instructions.
      yield* fileSystem.makeDirectory(root, { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, "AGENTS.md"), "My rules.\n");

      const first = yield* home.ensure(firstmate);
      assert.equal(yield* fileSystem.readFileString(path.join(root, "AGENTS.md")), "My rules.\n");
      assert.equal(yield* gitOutput(repo, ["log", "--format=%s"]), "Add home files for Firstmate");
      assert.equal(yield* gitOutput(repo, ["status", "--porcelain"]), "?? agents/firstmate/AGENTS.md");

      // Edits and deletions after the seed: only the missing file comes back.
      yield* fileSystem.writeFileString(path.join(root, "notes", "README.md"), "Edited.\n");
      yield* fileSystem.remove(path.join(repo, "README.md"));
      const second = yield* home.ensure(firstmate);
      assert.equal(second.projectId, first.projectId);
      assert.equal(
        yield* fileSystem.readFileString(path.join(root, "notes", "README.md")),
        "Edited.\n",
      );
      assert.isTrue(yield* fileSystem.exists(path.join(repo, "README.md")));
      // The restored file matches the seed commit, so there is nothing new to record.
      assert.equal(yield* gitOutput(repo, ["rev-list", "--count", "HEAD"]), "1");
      assert.equal(
        yield* gitOutput(repo, ["status", "--porcelain"]),
        "M agents/firstmate/notes/README.md\n?? agents/firstmate/AGENTS.md",
      );

      // Notes the agent added later are never touched.
      yield* fileSystem.writeFileString(path.join(root, "notes", "people.md"), "Ana: PM\n");
      yield* home.ensure(firstmate);
      assert.equal(
        yield* fileSystem.readFileString(path.join(root, "notes", "people.md")),
        "Ana: PM\n",
      );
      assert.equal(yield* gitOutput(repo, ["rev-list", "--count", "HEAD"]), "1");
      const snapshot = yield* projects.snapshot;
      assert.lengthOf(
        snapshot.projects.filter((project) => project.workspaceRoot === root),
        1,
      );
    }),
  ),
);

it.effect("follows T3CODE_AGENTS_HOME, renames the project, and rewrites the role", () =>
  withHome(
    ({ homeDir }) =>
      Effect.gen(function* () {
        const home = yield* FirstmateHome.FirstmateHome;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repo = path.join(homeDir, "mates");
        const folder = path.join(repo, "agents", "firstmate");
        // Before the project exists a rename does nothing.
        yield* home.rename({ slug: "firstmate", name: "Jarvis" });

        const { projectId } = yield* home.ensure({ ...firstmate, role: "Old role." });
        assert.isTrue(yield* fileSystem.exists(path.join(folder, "AGENTS.md")));
        assert.isFalse(yield* fileSystem.exists(path.join(homeDir, "agents")));

        yield* home.rename({ slug: "firstmate", name: "Jarvis" });
        assert.equal(Option.getOrThrow(yield* projects.getById(projectId)).title, "Jarvis");

        // The role is replaced between its markers; the rest of the file stays.
        yield* fileSystem.writeFileString(
          path.join(folder, "AGENTS.md"),
          (yield* fileSystem.readFileString(path.join(folder, "AGENTS.md"))) + "\nUser line.\n",
        );
        yield* home.writeRole({ slug: "firstmate", name: "Jarvis", role: "New role." });
        const agentsMd = yield* fileSystem.readFileString(path.join(folder, "AGENTS.md"));
        assert.include(agentsMd, "New role.");
        assert.notInclude(agentsMd, "Old role.");
        assert.include(agentsMd, "User line.");
        assert.equal(
          yield* gitOutput(repo, ["log", "--format=%s", "-1"]),
          "Update Jarvis's role",
        );
      }),
    { T3CODE_AGENTS_HOME: "~/mates" },
  ),
);

it.effect("keeps a copy of a review image under artifacts/, outside Git", () =>
  withHome(({ homeDir }) =>
    Effect.gen(function* () {
      const home = yield* FirstmateHome.FirstmateHome;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* home.ensure(firstmate);
      const source = path.join(homeDir, "worktree", "shot.png");
      yield* fileSystem.makeDirectory(path.dirname(source), { recursive: true });
      yield* fileSystem.writeFileString(source, "png bytes");
      const kept = yield* home.keepImage({ taskId: "firstmate-task:abc", path: source });
      const folder = path.join(homeDir, "agents", FirstmateHome.ARTIFACTS_FOLDER);
      assert.isTrue(kept.startsWith(path.join(folder, "firstmate-task-abc") + path.sep));
      assert.isTrue(kept.endsWith("-shot.png"));
      assert.strictEqual(yield* fileSystem.readFileString(kept), "png bytes");
      // A path already kept is not copied again.
      assert.strictEqual(yield* home.keepImage({ taskId: "firstmate-task:abc", path: kept }), kept);
      assert.strictEqual(
        yield* gitOutput(path.join(homeDir, "agents"), ["status", "--porcelain"]),
        "",
      );
    }),
  ),
);

it.effect("moves a pre-agents ~/firstmate into agents/firstmate, keeping its history and project", () =>
  withHome(({ homeDir }) =>
    Effect.gen(function* () {
      const home = yield* FirstmateHome.FirstmateHome;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const legacy = path.join(homeDir, "firstmate");
      const repo = path.join(homeDir, "agents");
      const target = path.join(repo, "agents", "firstmate");

      // Nothing to move: a fresh machine.
      assert.isNull(yield* home.migrateLegacyHome());

      // A Firstmate folder with its own history, notes, a kept image, and a project.
      yield* fileSystem.makeDirectory(path.join(legacy, "notes"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(legacy, "AGENTS.md"), "# Firstmate\n");
      yield* fileSystem.writeFileString(path.join(legacy, "notes", "people.md"), "Ana: PM\n");
      yield* fileSystem.makeDirectory(path.join(legacy, "artifacts", "t"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(legacy, "artifacts", "t", "shot.png"), "png");
      yield* fileSystem.writeFileString(path.join(legacy, ".gitignore"), "/artifacts/\n");
      yield* gitOutput(legacy, ["init", "--initial-branch=main"]);
      yield* gitOutput(legacy, ["add", "AGENTS.md", "notes", ".gitignore"]);
      yield* gitOutput(legacy, [
        "-c", "user.name=Me", "-c", "user.email=me@example.com", "commit", "-m", "Old history",
      ]);
      const { project } = yield* projects.bootstrap({
        commandId: "cmd:legacy" as never,
        projectId: "project:legacy" as never,
        title: "Firstmate",
        workspaceRoot: legacy,
      });

      const moved = yield* home.migrateLegacyHome();
      assert.deepEqual(moved, { from: legacy, to: target });
      assert.isFalse(yield* fileSystem.exists(legacy));
      assert.equal(
        yield* fileSystem.readFileString(path.join(target, "notes", "people.md")),
        "Ana: PM\n",
      );
      // History is the repository's now: the old commit, then the move, then the shared files.
      assert.equal(
        yield* gitOutput(repo, ["log", "--format=%s", "--reverse"]),
        "Old history\nMove Firstmate into agents/firstmate\nAdd the shared agents home files",
      );
      assert.equal(yield* gitOutput(repo, ["status", "--porcelain"]), "");
      assert.isTrue(yield* fileSystem.exists(path.join(repo, "AGENTS.md")));
      // Kept images move to the repository's artifacts folder.
      assert.equal(
        yield* fileSystem.readFileString(path.join(repo, "artifacts", "t", "shot.png")),
        "png",
      );
      // The project follows the folder; a backup of the old folder stays beside it.
      assert.equal(
        Option.getOrThrow(yield* projects.getById(project.id)).workspaceRoot,
        target,
      );
      const backups = (yield* fileSystem.readDirectory(homeDir)).filter((name) =>
        name.startsWith("firstmate.bak-"),
      );
      assert.lengthOf(backups, 1);

      // Done once: a second call finds nothing to move.
      assert.isNull(yield* home.migrateLegacyHome());
      const { projectId } = yield* home.ensure(firstmate);
      assert.equal(projectId, project.id);
    }),
  ),
);
