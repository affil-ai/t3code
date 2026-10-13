import { readFirstmateHome } from "~/state/firstmate";
import { firstmateHomeProjectKeys } from "./firstmateChatLists.logic";

/** Firstmate's home project key, for the Work sidebar's new chat to skip. */
export function readFirstmateHomeProjectKeys(): ReadonlySet<string> {
  const home = readFirstmateHome();
  return firstmateHomeProjectKeys(
    home?.environmentId ?? null,
    home?.snapshot.homeProjectId ?? null,
  );
}
