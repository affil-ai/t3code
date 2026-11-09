// @effect-diagnostics nodeBuiltinImport:off -- A plain Node app; it does not use Effect.
/**
 * `resend-slack <channel> <ts>`: hands one Slack message to the bridge again,
 * for a message its dedupe dropped, such as a relayed row Office recorded again
 * under a new event id. Runs with the bridge stopped; its next start handles it.
 */
import type * as NodeSqlite from "node:sqlite";

import type { InboundEvent } from "../bridge.ts";
import { forgetChatSdkMessage } from "../chatState.ts";
import type { BridgeStore } from "../store.ts";

/** Where `start` records its process id, so `resend-slack` can refuse while it runs. */
export const RUNNING_PID_KEY = "running_pid";

/** The pid of a bridge still running on this data dir, if any. */
export function runningBridge(
  store: BridgeStore,
  alive: (pid: number) => boolean = processAlive,
): number | undefined {
  const pid = Number(store.meta(RUNNING_PID_KEY));
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid) ? pid : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists under another user.
    return (error as { code?: string }).code === "EPERM";
  }
}

/**
 * Reads the message from Slack, clears the bridge's and the Chat SDK's records
 * of it, and saves it to the bridge's inbox, in one step. The next start hands
 * it to T3 as a normal message, once; T3's retry key still returns an earlier
 * hand-off of it rather than sending it twice.
 */
export async function resendSlackMessage(options: {
  readonly db: NodeSqlite.DatabaseSync;
  readonly store: BridgeStore;
  readonly channel: string;
  readonly ts: string;
  readonly messageEvent: (channel: string, ts: string) => Promise<InboundEvent | undefined>;
}): Promise<InboundEvent> {
  const event = await options.messageEvent(options.channel, options.ts);
  if (event === undefined)
    throw new Error(
      `Slack has no message ${options.ts} in ${options.channel} the bridge would handle (it may be a bot's).`,
    );
  options.store.transaction(() => {
    options.store.forgetMessage(event.eventId);
    forgetChatSdkMessage(options.db, "slack", event.messageId);
    if (
      !options.store.enqueue({
        eventId: event.eventId,
        chatThreadKey: event.chatThreadKey,
        event: JSON.stringify(event),
      })
    )
      throw new Error(`${event.eventId} could not be saved to the inbox.`);
  });
  return event;
}
