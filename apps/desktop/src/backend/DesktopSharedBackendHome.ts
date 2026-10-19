// @effect-diagnostics nodeBuiltinImport:off -- Synchronous startup probe of another app's runtime file.
/**
 * T3 Work's local backend shares its server state (threads, projects,
 * worktrees) with the upstream T3 Code app in `~/.t3`. Two backends must never
 * open the same state database at once, so while another backend is running
 * there, T3 Work falls back to its own home.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Whether a live T3 backend other than this app's currently owns `t3Home`. */
export function isBackendHomeInUse(t3Home: string): boolean {
  let pid: unknown;
  try {
    const runtime: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(t3Home, "userdata", "server-runtime.json"), "utf8"),
    );
    pid = runtime && typeof runtime === "object" ? (runtime as { pid?: unknown }).pid : undefined;
  } catch {
    return false;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  // The runtime file is cleared on clean shutdown; a crash can leave a pid
  // that was since reused, so confirm it is a T3 backend.
  try {
    const command = NodeChildProcess.execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    return command.includes("bin.mjs");
  } catch {
    return false;
  }
}

export function resolvePrimaryBackendHome(input: {
  readonly baseDir: string;
  readonly sharedHomeDir: string | undefined;
  readonly isInUse?: (t3Home: string) => boolean;
}): { readonly t3Home: string; readonly sharedHomeBlocked: boolean } {
  if (input.sharedHomeDir === undefined) {
    return { t3Home: input.baseDir, sharedHomeBlocked: false };
  }
  const isInUse = input.isInUse ?? isBackendHomeInUse;
  return isInUse(input.sharedHomeDir)
    ? { t3Home: input.baseDir, sharedHomeBlocked: true }
    : { t3Home: input.sharedHomeDir, sharedHomeBlocked: false };
}
