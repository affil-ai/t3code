import { readFirstmateHome } from "~/state/firstmate";
import { firstmateHomeProjectKeys } from "@t3tools/client-runtime/firstmate/chat-lists";

/** Firstmate's home project key, for the Work sidebar's new chat to skip. */
export function readFirstmateHomeProjectKeys(): ReadonlySet<string> {
  const home = readFirstmateHome();
  return firstmateHomeProjectKeys(
    home?.environmentId ?? null,
    home?.snapshot.homeProjectId ?? null,
  );
}
