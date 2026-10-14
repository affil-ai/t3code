import { isElectron } from "./env";
import { useWorkModeStore, type AppMode } from "./workModeStore";

export function getIdentityDefaultAppMode(identity: unknown): AppMode | null {
  if (!identity || typeof identity !== "object") return null;
  const email = (identity as { email?: unknown }).email;
  if (typeof email !== "string" || email.trim() === "") return null;
  return email.trim().toLowerCase() === "vivek@affil.ai" ? "work" : "agents";
}

export async function initializeHostedAppMode(): Promise<void> {
  if (
    typeof window === "undefined" ||
    isElectron ||
    import.meta.env.DEV ||
    window.location.origin !== "https://t3.olumbe.com" ||
    useWorkModeStore.getState().hasExplicitMode
  ) {
    return;
  }

  try {
    const response = await fetch("/cdn-cgi/access/get-identity", {
      credentials: "same-origin",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return;
    const mode = getIdentityDefaultAppMode(await response.json());
    if (mode !== null) {
      // Persist only the mode as a startup cache; do not retain the identity email.
      useWorkModeStore.getState().applyIdentityDefault(mode);
    }
  } catch {
    // An unavailable Access identity leaves the current default unchanged.
  }
}
