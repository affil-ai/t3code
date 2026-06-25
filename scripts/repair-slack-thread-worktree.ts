#!/usr/bin/env node
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics nodeBuiltinImport:off

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

interface Config {
  readonly threadId: string;
  readonly replacementThreadId: string | undefined;
  readonly createReplacementThread: boolean;
  readonly dbPath: string;
  readonly baseRef: string;
  readonly remote: string;
  readonly backupDir: string | undefined;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly repairWorktree: boolean;
  readonly runSetup: boolean;
  readonly clearProviderRuntime: boolean;
}

interface ThreadRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly thread_title: string;
  readonly model_selection_json: string | null;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly branch: string | null;
  readonly worktree_path: string | null;
  readonly project_title: string;
  readonly workspace_root: string;
}

interface ExternalThreadLinkRow {
  readonly source: string;
  readonly external_thread_id: string;
  readonly primary_external_message_id: string | null;
  readonly url: string | null;
  readonly muted: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface PendingTurnRow {
  readonly row_id: number;
  readonly pending_message_id: string | null;
  readonly turn_id: string | null;
  readonly state: string;
  readonly requested_at: string;
}

interface ProviderRuntimeRow {
  readonly thread_id: string;
  readonly status: string;
  readonly provider_name: string;
  readonly resume_cursor_json: string | null;
}

function usage(): string {
  return `
Usage:
  node scripts/repair-slack-thread-worktree.ts --thread-id <uuid> [options]

Options:
  --db <path>                 SQLite state DB. Defaults to $T3CODE_STATE_DB or ~/.t3/userdata/state.sqlite.
  --create-replacement-thread Create a fresh T3 thread projection by cloning --thread-id metadata.
  --replacement-thread-id <id> Move Slack external_thread_links from --thread-id to this T3 thread
                              after repairing the replacement thread worktree.
  --base-ref <ref>            Base branch/ref for recreating the worktree. Defaults to dev.
                              "dev" becomes "origin/dev"; "origin/main" fetches main from origin.
  --remote <name>             Git remote used for branch base refs. Defaults to origin.
  --backup-dir <path>         Backup destination. Defaults to ~/.t3/repair-backups/<timestamp>-<thread>.
  --force                     Allow replacing a valid existing target branch.
  --skip-worktree-repair      Only retarget Slack links and runtime state; do not recreate worktree.
  --skip-setup                Do not run scripts/worktree-setup.sh or .t3code/worktree-setup.sh.
  --keep-provider-runtime     Do not clear the stale provider_session_runtime row.
  --dry-run                   Print intended actions without writing files or DB rows.
  --help                      Show this help.

By default the script repairs the existing T3 thread in place. With --replacement-thread-id, it
keeps the same Slack external thread but retargets future Slack replies to the replacement T3 thread.
`.trim();
}

function parseArgs(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env): Config {
  const args = [...argv];
  let threadId = "";
  let replacementThreadId: string | undefined;
  let createReplacementThread = false;
  let dbPath = env.T3CODE_STATE_DB ?? path.join(homedir(), ".t3", "userdata", "state.sqlite");
  let baseRef = "dev";
  let remote = "origin";
  let backupDir: string | undefined;
  let dryRun = false;
  let force = false;
  let repairWorktree = true;
  let runSetup = true;
  let clearProviderRuntime = true;

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--help":
      case "-h":
        console.log(usage());
        process.exit(0);
      case "--thread-id":
        threadId = requireValue(arg, args.shift());
        break;
      case "--create-replacement-thread":
        createReplacementThread = true;
        break;
      case "--replacement-thread-id":
        replacementThreadId = requireValue(arg, args.shift());
        break;
      case "--db":
        dbPath = requireValue(arg, args.shift());
        break;
      case "--base-ref":
        baseRef = requireValue(arg, args.shift());
        break;
      case "--remote":
        remote = requireValue(arg, args.shift());
        break;
      case "--backup-dir":
        backupDir = requireValue(arg, args.shift());
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--force":
        force = true;
        break;
      case "--skip-worktree-repair":
        repairWorktree = false;
        break;
      case "--skip-setup":
        runSetup = false;
        break;
      case "--keep-provider-runtime":
        clearProviderRuntime = false;
        break;
      default:
        throw new Error(`Unknown argument: ${String(arg)}\n\n${usage()}`);
    }
  }

  if (threadId.trim().length === 0) {
    throw new Error(`Missing required --thread-id.\n\n${usage()}`);
  }
  if (createReplacementThread && replacementThreadId !== undefined) {
    throw new Error("--create-replacement-thread cannot be combined with --replacement-thread-id.");
  }

  return {
    threadId: threadId.trim(),
    replacementThreadId: replacementThreadId === undefined ? undefined : replacementThreadId.trim(),
    createReplacementThread,
    dbPath: resolveUserPath(dbPath),
    baseRef: baseRef.trim(),
    remote: remote.trim(),
    backupDir: backupDir === undefined ? undefined : resolveUserPath(backupDir),
    dryRun,
    force,
    repairWorktree,
    runSetup,
    clearProviderRuntime,
  };
}

function requireValue(flag: string | undefined, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function resolveUserPath(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(homedir(), input.slice(2));
  }
  return path.resolve(input);
}

function shellQuote(value: string): string {
  if (/^[\w./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandLine(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly dryRun?: boolean;
    readonly quiet?: boolean;
  } = {},
): string {
  const cwdText = options.cwd ? ` (cwd ${options.cwd})` : "";
  if (!options.quiet) {
    console.log(`$ ${commandLine(command, args)}${cwdText}`);
  }
  if (options.dryRun) {
    return "";
  }

  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    encoding: "utf8",
  });
  if (!options.quiet && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (!options.quiet && result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    const details = [
      result.stderr.trim(),
      result.stdout.trim(),
      result.error instanceof Error ? result.error.message : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n");
    throw new Error(
      `Command failed: ${commandLine(command, args)}${details ? `\n${details}` : ""}`,
    );
  }
  return result.stdout;
}

function check(command: string, args: ReadonlyArray<string>, cwd?: string): boolean {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "ignore",
  });
  return result.status === 0;
}

function backupPathFor(config: Config): string {
  if (config.backupDir !== undefined) {
    return config.backupDir;
  }
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const threadPrefix = config.threadId.slice(0, 8);
  return path.join(homedir(), ".t3", "repair-backups", `${timestamp}-${threadPrefix}`);
}

function readThread(db: DatabaseSync, threadId: string): ThreadRow {
  const row = db
    .prepare(
      `
        SELECT
          threads.thread_id,
          threads.project_id,
          threads.title AS thread_title,
          threads.model_selection_json,
          threads.runtime_mode,
          threads.interaction_mode,
          threads.branch,
          threads.worktree_path,
          projects.title AS project_title,
          projects.workspace_root
        FROM projection_threads AS threads
        JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ?
      `,
    )
    .get(threadId) as ThreadRow | undefined;

  if (row === undefined) {
    throw new Error(`No projection_threads row found for thread ${threadId}.`);
  }
  return row;
}

function readSlackLinks(db: DatabaseSync, threadId: string): ReadonlyArray<ExternalThreadLinkRow> {
  return db
    .prepare(
      `
        SELECT
          source,
          external_thread_id,
          primary_external_message_id,
          url,
          muted,
          created_at,
          updated_at
        FROM external_thread_links
        WHERE t3_thread_id = ?
          AND source = 'slack'
        ORDER BY created_at ASC, external_thread_id ASC
      `,
    )
    .all(threadId) as unknown as ReadonlyArray<ExternalThreadLinkRow>;
}

function readPendingTurns(db: DatabaseSync, threadId: string): ReadonlyArray<PendingTurnRow> {
  return db
    .prepare(
      `
        SELECT row_id, pending_message_id, turn_id, state, requested_at
        FROM projection_turns
        WHERE thread_id = ?
          AND state IN ('pending', 'running')
        ORDER BY requested_at DESC, row_id DESC
      `,
    )
    .all(threadId) as unknown as ReadonlyArray<PendingTurnRow>;
}

function readProviderRuntime(db: DatabaseSync, threadId: string): ProviderRuntimeRow | undefined {
  return db
    .prepare(
      `
        SELECT thread_id, status, provider_name, resume_cursor_json
        FROM provider_session_runtime
        WHERE thread_id = ?
      `,
    )
    .get(threadId) as ProviderRuntimeRow | undefined;
}

function createReplacementThread(db: DatabaseSync, config: Config, source: ThreadRow): ThreadRow {
  if (source.model_selection_json === null || source.model_selection_json.trim().length === 0) {
    throw new Error(`Source thread ${source.thread_id} does not have model_selection_json.`);
  }

  const targetThreadId = randomUUID();
  const now = new Date().toISOString();
  const title = `${source.thread_title} (recovered)`;
  const commandId = `repair-slack-thread:create-replacement:${targetThreadId}`;
  const eventId = randomUUID();
  const eventPayload = {
    threadId: targetThreadId,
    projectId: source.project_id,
    title,
    modelSelection: JSON.parse(source.model_selection_json) as unknown,
    runtimeMode: source.runtime_mode,
    interactionMode: source.interaction_mode,
    branch: source.branch,
    worktreePath: source.worktree_path,
    createdAt: now,
    updatedAt: now,
  };

  console.log(`Creating replacement T3 thread ${targetThreadId}.`);
  if (config.dryRun) {
    return {
      ...source,
      thread_id: targetThreadId,
      thread_title: title,
    };
  }

  db.exec("BEGIN IMMEDIATE;");
  try {
    db.prepare(
      `
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (?, 'thread', ?, 1, 'thread.created', ?, ?, NULL, ?, 'server', ?, '{}')
      `,
    ).run(eventId, targetThreadId, now, commandId, commandId, JSON.stringify(eventPayload));

    db.prepare(
      `
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, 0, 0, 0, NULL)
      `,
    ).run(
      targetThreadId,
      source.project_id,
      title,
      source.model_selection_json,
      source.runtime_mode,
      source.interaction_mode,
      source.branch,
      source.worktree_path,
      now,
      now,
    );

    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }

  return readThread(db, targetThreadId);
}

function assertRepairableThread(row: ThreadRow): asserts row is ThreadRow & {
  readonly branch: string;
  readonly worktree_path: string;
} {
  if (row.branch === null || row.branch.trim().length === 0) {
    throw new Error(`Thread ${row.thread_id} does not have a branch recorded.`);
  }
  if (row.worktree_path === null || row.worktree_path.trim().length === 0) {
    throw new Error(`Thread ${row.thread_id} does not have a worktree_path recorded.`);
  }
}

function resolveGitCommonDir(projectRoot: string): string {
  const output = run("git", ["rev-parse", "--git-common-dir"], {
    cwd: projectRoot,
    quiet: true,
  }).trim();
  return path.isAbsolute(output) ? output : path.resolve(projectRoot, output);
}

function backupIfExists(source: string, destination: string, config: Config): void {
  if (!existsSync(source)) {
    return;
  }

  console.log(`Backing up ${source} -> ${destination}`);
  if (config.dryRun) {
    return;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true, verbatimSymlinks: true });
}

function moveIfExists(source: string, destination: string, config: Config): void {
  if (!existsSync(source)) {
    return;
  }

  console.log(`Moving ${source} -> ${destination}`);
  if (config.dryRun) {
    return;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  renameSync(source, destination);
}

function removeIfExists(target: string, config: Config): void {
  if (!existsSync(target)) {
    return;
  }

  console.log(`Removing ${target}`);
  if (!config.dryRun) {
    rmSync(target, { recursive: true, force: true });
  }
}

function pruneEmptyParents(start: string, stopAt: string, config: Config): void {
  let current = path.dirname(start);
  const stop = path.resolve(stopAt);
  while (path.resolve(current).startsWith(stop) && path.resolve(current) !== stop) {
    if (!existsSync(current) || readdirSync(current).length > 0) {
      break;
    }
    console.log(`Removing empty directory ${current}`);
    if (!config.dryRun) {
      rmSync(current, { recursive: false });
    }
    current = path.dirname(current);
  }
}

function branchRefPath(gitCommonDir: string, branch: string): string {
  return path.join(gitCommonDir, "refs", "heads", ...branch.split("/"));
}

function checkpointRefPath(gitCommonDir: string, threadId: string): string {
  return path.join(
    gitCommonDir,
    "refs",
    "t3",
    "checkpoints",
    Buffer.from(threadId).toString("base64url"),
  );
}

function gitMetadataPath(gitCommonDir: string, worktreePath: string): string {
  return path.join(gitCommonDir, "worktrees", path.basename(worktreePath));
}

function resolveBaseRef(config: Config): {
  readonly fetchBranch?: string;
  readonly checkoutRef: string;
} {
  const trimmed = config.baseRef.replace(/^refs\/heads\//, "");
  const remotePrefix = `${config.remote}/`;
  if (trimmed.startsWith(remotePrefix)) {
    return {
      fetchBranch: trimmed.slice(remotePrefix.length),
      checkoutRef: trimmed,
    };
  }
  if (!trimmed.includes("/")) {
    return {
      fetchBranch: trimmed,
      checkoutRef: `${config.remote}/${trimmed}`,
    };
  }
  return { checkoutRef: trimmed };
}

function isValidWorktree(worktreePath: string): boolean {
  return (
    existsSync(worktreePath) && check("git", ["-C", worktreePath, "rev-parse", "--show-toplevel"])
  );
}

function recreateWorktree(
  config: Config,
  input: {
    readonly projectRoot: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly backupDir: string;
  },
): void {
  const gitCommonDir = resolveGitCommonDir(input.projectRoot);
  const metadataPath = gitMetadataPath(gitCommonDir, input.worktreePath);
  const looseBranchRefPath = branchRefPath(gitCommonDir, input.branch);
  const threadCheckpointRefPath = checkpointRefPath(gitCommonDir, config.threadId);
  const targetBranchRef = `refs/heads/${input.branch}`;

  if (isValidWorktree(input.worktreePath) && !config.force) {
    throw new Error(
      `Worktree ${input.worktreePath} is already a valid git worktree. Use --force only if you intend to replace it.`,
    );
  }

  const branchIsValid = check(
    "git",
    ["show-ref", "--verify", "--quiet", targetBranchRef],
    input.projectRoot,
  );
  if (branchIsValid && !config.force) {
    throw new Error(
      `Branch ${input.branch} already exists and has a valid ref. Use --force only if replacing it is intentional.`,
    );
  }

  if (!config.dryRun) {
    mkdirSync(input.backupDir, { recursive: true });
  }
  moveIfExists(input.worktreePath, path.join(input.backupDir, "worktree"), config);
  backupIfExists(metadataPath, path.join(input.backupDir, "git-worktree-metadata"), config);
  backupIfExists(looseBranchRefPath, path.join(input.backupDir, "branch-ref"), config);
  backupIfExists(threadCheckpointRefPath, path.join(input.backupDir, "checkpoint-refs"), config);

  removeIfExists(metadataPath, config);
  removeIfExists(threadCheckpointRefPath, config);
  if (branchIsValid) {
    run("git", ["branch", "-D", input.branch], {
      cwd: input.projectRoot,
      dryRun: config.dryRun,
    });
  } else {
    removeIfExists(looseBranchRefPath, config);
    pruneEmptyParents(looseBranchRefPath, path.join(gitCommonDir, "refs", "heads"), config);
  }

  run("git", ["worktree", "prune"], {
    cwd: input.projectRoot,
    dryRun: config.dryRun,
  });

  const base = resolveBaseRef(config);
  if (base.fetchBranch !== undefined) {
    run(
      "git",
      [
        "fetch",
        "--quiet",
        "--no-tags",
        config.remote,
        `+refs/heads/${base.fetchBranch}:refs/remotes/${config.remote}/${base.fetchBranch}`,
      ],
      { cwd: input.projectRoot, dryRun: config.dryRun },
    );
  }

  if (!config.dryRun) {
    mkdirSync(path.dirname(input.worktreePath), { recursive: true });
  }
  run(
    "git",
    ["worktree", "add", "--no-track", "-b", input.branch, input.worktreePath, base.checkoutRef],
    {
      cwd: input.projectRoot,
      dryRun: config.dryRun,
    },
  );
}

function runSetupIfPresent(
  config: Config,
  input: {
    readonly projectRoot: string;
    readonly worktreePath: string;
  },
): void {
  if (!config.runSetup) {
    console.log("Skipping worktree setup because --skip-setup was provided.");
    return;
  }

  const candidates = [
    path.join(input.worktreePath, "scripts", "worktree-setup.sh"),
    path.join(input.worktreePath, ".t3code", "worktree-setup.sh"),
  ];
  const setupScript = candidates.find((candidate) => existsSync(candidate));
  if (setupScript === undefined) {
    console.log("No worktree setup script found.");
    return;
  }

  run("bash", [setupScript], {
    cwd: input.worktreePath,
    dryRun: config.dryRun,
    env: {
      T3CODE_PROJECT_ROOT: input.projectRoot,
      T3CODE_WORKTREE_PATH: input.worktreePath,
    },
  });
}

function clearProviderRuntimeIfRequested(
  db: DatabaseSync,
  config: Config,
  targetThreadId: string,
): number {
  if (!config.clearProviderRuntime) {
    console.log("Keeping provider_session_runtime because --keep-provider-runtime was provided.");
    return 0;
  }
  if (config.dryRun) {
    console.log(`Would delete provider_session_runtime row for ${targetThreadId}.`);
    return 0;
  }
  const result = db
    .prepare("DELETE FROM provider_session_runtime WHERE thread_id = ?")
    .run(targetThreadId);
  return Number(result.changes);
}

function relinkSlackLinksIfRequested(
  db: DatabaseSync,
  config: Config,
  input: {
    readonly sourceThreadId: string;
    readonly targetThreadId: string;
    readonly targetProjectId: string;
  },
): number {
  if (config.replacementThreadId === undefined && !config.createReplacementThread) {
    return 0;
  }
  if (config.dryRun) {
    console.log(
      `Would retarget Slack external_thread_links from ${input.sourceThreadId} to ${input.targetThreadId}.`,
    );
    return 0;
  }

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `
        UPDATE external_thread_links
        SET
          t3_thread_id = ?,
          project_id = ?,
          updated_at = ?
        WHERE source = 'slack'
          AND t3_thread_id = ?
      `,
    )
    .run(input.targetThreadId, input.targetProjectId, now, input.sourceThreadId);
  return Number(result.changes);
}

function printSummary(input: {
  readonly sourceThread: ThreadRow;
  readonly thread: ThreadRow & { readonly branch: string; readonly worktree_path: string };
  readonly slackLinks: ReadonlyArray<ExternalThreadLinkRow>;
  readonly pendingTurns: ReadonlyArray<PendingTurnRow>;
  readonly providerRuntime: ProviderRuntimeRow | undefined;
  readonly backupDir: string;
}): void {
  console.log("");
  console.log("Repair target:");
  if (input.sourceThread.thread_id !== input.thread.thread_id) {
    console.log(
      `  Slack source thread: ${input.sourceThread.thread_title} (${input.sourceThread.thread_id})`,
    );
  }
  console.log(`  Project: ${input.thread.project_title} (${input.thread.project_id})`);
  console.log(`  Thread: ${input.thread.thread_title} (${input.thread.thread_id})`);
  console.log(`  Branch: ${input.thread.branch}`);
  console.log(`  Worktree: ${input.thread.worktree_path}`);
  console.log(`  Backup: ${input.backupDir}`);
  console.log("");
  console.log(`Slack links preserved: ${input.slackLinks.length}`);
  for (const link of input.slackLinks) {
    console.log(`  ${link.external_thread_id}${link.url ? ` -> ${link.url}` : ""}`);
  }
  if (input.providerRuntime !== undefined) {
    console.log("");
    console.log(
      `Provider runtime before repair: ${input.providerRuntime.provider_name} ${input.providerRuntime.status}`,
    );
  }
  if (input.pendingTurns.length > 0) {
    console.log("");
    console.log("Pending/running turns currently recorded:");
    for (const turn of input.pendingTurns) {
      console.log(
        `  row ${turn.row_id}: ${turn.state}, message ${turn.pending_message_id ?? "none"}, requested ${turn.requested_at}`,
      );
    }
  }
}

function verifyWorktree(worktreePath: string): void {
  run("git", ["-C", worktreePath, "status", "--short", "--branch"]);
}

function main(): void {
  const config = parseArgs(process.argv.slice(2));
  const backupDir = backupPathFor(config);
  const db = new DatabaseSync(config.dbPath);
  try {
    const sourceThread = readThread(db, config.threadId);
    const targetThread = config.createReplacementThread
      ? createReplacementThread(db, config, sourceThread)
      : config.replacementThreadId === undefined
        ? sourceThread
        : readThread(db, config.replacementThreadId);
    assertRepairableThread(targetThread);
    if (sourceThread.project_id !== targetThread.project_id && !config.force) {
      throw new Error(
        `Source thread project (${sourceThread.project_id}) does not match replacement thread project (${targetThread.project_id}). Use --force only if this relink is intentional.`,
      );
    }
    const projectRoot = resolveUserPath(targetThread.workspace_root);
    const worktreePath = resolveUserPath(targetThread.worktree_path);
    const slackLinks = readSlackLinks(db, sourceThread.thread_id);
    const pendingTurns = readPendingTurns(db, targetThread.thread_id);
    const providerRuntime = readProviderRuntime(db, targetThread.thread_id);

    if (slackLinks.length === 0) {
      throw new Error(
        `Thread ${config.threadId} has no Slack external_thread_links row; refusing Slack repair.`,
      );
    }
    if (!existsSync(projectRoot) || !statSync(projectRoot).isDirectory()) {
      throw new Error(`Project workspace_root is not a directory: ${projectRoot}`);
    }

    printSummary({
      sourceThread,
      thread: { ...targetThread, worktree_path: worktreePath },
      slackLinks,
      pendingTurns,
      providerRuntime,
      backupDir,
    });

    if (config.repairWorktree) {
      recreateWorktree(config, {
        projectRoot,
        worktreePath,
        branch: targetThread.branch,
        backupDir,
      });
      runSetupIfPresent(config, { projectRoot, worktreePath });
    } else {
      console.log("Skipping worktree repair because --skip-worktree-repair was provided.");
    }
    const relinkedSlackRows = relinkSlackLinksIfRequested(db, config, {
      sourceThreadId: sourceThread.thread_id,
      targetThreadId: targetThread.thread_id,
      targetProjectId: targetThread.project_id,
    });
    const deletedRuntimeRows = clearProviderRuntimeIfRequested(db, config, targetThread.thread_id);
    const slackLinksAfterRepair = readSlackLinks(db, targetThread.thread_id);

    console.log("");
    console.log(`Relinked Slack external_thread_links rows: ${relinkedSlackRows}`);
    console.log(`Deleted provider_session_runtime rows: ${deletedRuntimeRows}`);
    console.log(`Slack links after repair: ${slackLinksAfterRepair.length}`);
    if (!config.dryRun && config.repairWorktree) {
      verifyWorktree(worktreePath);
    }
    console.log("");
    console.log("Repair complete.");
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
