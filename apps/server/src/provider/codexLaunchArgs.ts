import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

/** The provider Codex talks to unless a launch arg overrides it. */
export const CODEX_DEFAULT_MODEL_PROVIDER = "openai";

/**
 * The `model_provider` a launch config sets, in any of the forms the CLI
 * accepts: `-c model_provider=x`, `--config model_provider=x`, `-c=...`, or
 * `--config=...`. Quotes around the value are stripped by tokenization, and a
 * later override wins. Undefined when the launch args leave it alone.
 */
export const codexLaunchArgsModelProvider = (launchArgs?: string): string | undefined => {
  const args = codexLaunchArgv(launchArgs);
  let provider: string | undefined;
  const consider = (assignment: string | undefined) => {
    if (assignment === undefined) return;
    const match = assignment.match(/^\s*model_provider\s*=\s*(.*)$/);
    if (!match) return;
    const value = match[1]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    if (value) provider = value;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === "-c" || arg === "--config") {
      consider(args[index + 1]);
      index++;
    } else if (arg.startsWith("-c=")) {
      consider(arg.slice(3));
    } else if (arg.startsWith("--config=")) {
      consider(arg.slice("--config=".length));
    }
  }
  return provider;
};

/** True when the launch args route Codex through a provider other than ChatGPT's. */
export const codexLaunchArgsUseCustomModelProvider = (launchArgs?: string): boolean => {
  const provider = codexLaunchArgsModelProvider(launchArgs);
  return provider !== undefined && provider !== CODEX_DEFAULT_MODEL_PROVIDER;
};

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};
