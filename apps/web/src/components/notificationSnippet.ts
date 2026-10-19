/**
 * Reads a completed chat's final reply for its notification. The shell list
 * carries no message text, so this briefly mounts the chat's detail
 * subscription and stops as soon as the latest messages arrive.
 */
import type { EnvironmentThreadState } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import { formatNotificationSnippet, lastAssistantText } from "./notificationSnippet.logic";

/** A notification waits at most this long for the reply before showing without it. */
const SNIPPET_LOAD_TIMEOUT_MS = 2_500;

function loadedMessages(state: EnvironmentThreadState) {
  if (state.status !== "live" && state.status !== "cached") return undefined;
  return Option.getOrNull(state.data)?.messages;
}

/** The final reply as a one-line snippet, or null when it cannot be read in time. */
export function readCompletionSnippet(ref: ScopedThreadRef): Promise<string | null> {
  const atom = environmentThreadDetails.stateAtom(ref);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (snippet: string | null) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe();
      resolve(snippet);
    };
    const timeout = globalThis.setTimeout(() => finish(null), SNIPPET_LOAD_TIMEOUT_MS);
    unsubscribe = appAtomRegistry.subscribe(
      atom,
      (state) => {
        if (state.status === "deleted") return finish(null);
        const messages = loadedMessages(state);
        if (messages === undefined) return;
        const text = lastAssistantText(messages);
        finish(text === null ? null : formatNotificationSnippet(text));
      },
      { immediate: true },
    );
  });
}
