import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as CodexClient from "effect-codex-app-server/client";

import { ServerConfig } from "../config.ts";

/** Raw stderr belongs only in private files, not provider event or server logs. */
export const makeCodexAppServerDiagnosticWriter = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const directory = path.join(config.logsDir, "codex-app-server");

  const write: NonNullable<CodexClient.CodexAppServerClientOptions["writeStderrDiagnostic"]> =
    Effect.fnUntraced(
      function* (pid: number, tail: Uint8Array) {
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        yield* fs.chmod(directory, 0o700);
        const timestamp = yield* Clock.currentTimeMillis;
        const diagnosticPath = path.join(directory, `${timestamp}-${pid}.stderr`);
        // Never truncate an existing file or follow a pre-existing file symlink.
        yield* fs.writeFile(diagnosticPath, tail, { flag: "wx", mode: 0o600 });
        yield* fs.chmod(diagnosticPath, 0o600);
        yield* fs.readDirectory(directory).pipe(
          Effect.flatMap((files) =>
            Effect.forEach(
              files
                .filter((name) => /^\d{13}-\d+\.stderr$/.test(name))
                .sort()
                .toReversed()
                .slice(20),
              (name) => fs.remove(path.join(directory, name)).pipe(Effect.ignore),
              { discard: true },
            ),
          ),
          Effect.ignore,
        );
        return diagnosticPath;
      },
      Effect.orElseSucceed(() => undefined),
    );
  return write;
});
