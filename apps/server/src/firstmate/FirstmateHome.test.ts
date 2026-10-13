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
import { FIRSTMATE_HOME_FILES } from "./homeFiles.ts";

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

it.effect("seeds ~/firstmate as a committed repository and registers it as a project", () =>
  withHome(({ homeDir }) =>
    Effect.gen(function* () {
      const home = yield* FirstmateHome.FirstmateHome;
      const projects = yield* ProjectService.ProjectService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.join(homeDir, "firstmate");

      const { projectId } = yield* home.ensure({ name: "Jarvis" });

      for (const file of FIRSTMATE_HOME_FILES) {
        assert.equal(yield* fileSystem.readFileString(path.join(root, file.path)), file.content);
      }
      assert.equal(yield* fileSystem.readFileString(path.join(root, "CLAUDE.md")), "@AGENTS.md\n");
      assert.equal(
        yield* fileSystem.readLink(path.join(root, ".claude", "skills")),
        "../.agents/skills",
      );
      assert.isTrue(yield* fileSystem.exists(path.join(root, ".claude", "skills", "README.md")));

      assert.equal(
        yield* gitOutput(root, ["log", "--format=%s|%an <%ae>"]),
        "Add Firstmate home files|Firstmate <firstmate@localhost>",
      );
      assert.equal(yield* gitOutput(root, ["status", "--porcelain"]), "");

      const project = Option.getOrThrow(yield* projects.getById(projectId));
      assert.equal(project.title, "Jarvis");
      assert.equal(project.workspaceRoot, root);
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
      const root = path.join(homeDir, "firstmate");
      // A folder the user already started, with their own instructions.
      yield* fileSystem.makeDirectory(root, { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, "AGENTS.md"), "My rules.\n");

      const first = yield* home.ensure({ name: "Firstmate" });
      assert.equal(yield* fileSystem.readFileString(path.join(root, "AGENTS.md")), "My rules.\n");
      assert.equal(yield* gitOutput(root, ["log", "--format=%s"]), "Add Firstmate home files");
      assert.equal(yield* gitOutput(root, ["status", "--porcelain"]), "?? AGENTS.md");

      // Edits and deletions after the seed: only the missing file comes back.
      yield* fileSystem.writeFileString(path.join(root, "notes", "README.md"), "Edited.\n");
      yield* fileSystem.remove(path.join(root, "README.md"));
      const second = yield* home.ensure({ name: "Firstmate" });
      assert.equal(second.projectId, first.projectId);
      assert.equal(
        yield* fileSystem.readFileString(path.join(root, "notes", "README.md")),
        "Edited.\n",
      );
      assert.isTrue(yield* fileSystem.exists(path.join(root, "README.md")));
      // The restored file matches the seed commit, so there is nothing new to record.
      assert.equal(yield* gitOutput(root, ["rev-list", "--count", "HEAD"]), "1");
      assert.equal(
        yield* gitOutput(root, ["status", "--porcelain"]),
        "M notes/README.md\n?? AGENTS.md",
      );

      // Notes the agent added later are never touched.
      yield* fileSystem.writeFileString(path.join(root, "notes", "people.md"), "Ana: PM\n");
      yield* home.ensure({ name: "Firstmate" });
      assert.equal(
        yield* fileSystem.readFileString(path.join(root, "notes", "people.md")),
        "Ana: PM\n",
      );
      assert.equal(yield* gitOutput(root, ["rev-list", "--count", "HEAD"]), "1");
      const snapshot = yield* projects.snapshot;
      assert.lengthOf(
        snapshot.projects.filter((project) => project.workspaceRoot === root),
        1,
      );
    }),
  ),
);

it.effect("follows T3CODE_FIRSTMATE_HOME and renames the project", () =>
  withHome(
    ({ homeDir }) =>
      Effect.gen(function* () {
        const home = yield* FirstmateHome.FirstmateHome;
        const projects = yield* ProjectService.ProjectService;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(homeDir, "agents", "mate");
        // Before the project exists a rename does nothing.
        yield* home.rename("Jarvis");

        const { projectId } = yield* home.ensure({ name: "Firstmate" });
        assert.isTrue(yield* fileSystem.exists(path.join(root, "AGENTS.md")));
        assert.isFalse(yield* fileSystem.exists(path.join(homeDir, "firstmate")));

        yield* home.rename("Jarvis");
        assert.equal(Option.getOrThrow(yield* projects.getById(projectId)).title, "Jarvis");
      }),
    { T3CODE_FIRSTMATE_HOME: "~/agents/mate" },
  ),
);
