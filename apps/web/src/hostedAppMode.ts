import { isElectron } from "./env";
import { useSelectedAgentStore } from "./selectedAgentStore";
import { useWorkModeStore, type AppMode } from "./workModeStore";

/**
 * Everyone signed in through Access lands in Work. Vivek's sidebar opens on
 * Firstmate; anyone else's opens on the first custom agent, since the other
 * agents are what they are there for.
 */
export function getIdentityDefault(
  identity: unknown,
): { readonly mode: AppMode; readonly preferCustomAgent: boolean } | null {
  if (!identity || typeof identity !== "object") return null;
  const email = (identity as { email?: unknown }).email;
  if (typeof email !== "string" || email.trim() === "") return null;
  return { mode: "work", preferCustomAgent: email.trim().toLowerCase() !== "vivek@affil.ai" };
}

export function getIdentityDefaultAppMode(identity: unknown): AppMode | null {
  return getIdentityDefault(identity)?.mode ?? null;
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
    const identityDefault = getIdentityDefault(await response.json());
    if (identityDefault !== null) {
      // Persist only the defaults as a startup cache; do not retain the identity email.
      useWorkModeStore.getState().applyIdentityDefault(identityDefault.mode);
      useSelectedAgentStore.getState().setPreferCustomAgent(identityDefault.preferCustomAgent);
    }
  } catch {
    // An unavailable Access identity leaves the current default unchanged.
  }
}
