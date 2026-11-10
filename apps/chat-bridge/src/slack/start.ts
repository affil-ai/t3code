/** `slack_start`: post a Slack message for a T3 thread and bind that Slack thread to it. */
import type { Bridge } from "../bridge.ts";
import type { ChatPlatform } from "../platform.ts";
import { slackStartRefusal, type SlackStartRequest } from "../toolServer.ts";
import { slackWorkNote } from "./platform.ts";

export async function startSlackThread(
  deps: {
    readonly access: Parameters<typeof slackStartRefusal>[0];
    readonly platform: ChatPlatform | undefined;
    readonly core: Pick<Bridge, "attachRefusal" | "attach">;
  },
  request: SlackStartRequest,
): Promise<string> {
  const destination = slackStartRefusal(deps.access, request.channel);
  if (destination !== undefined) throw new Error(destination);
  const startConversation = deps.platform?.startConversation;
  if (startConversation === undefined) throw new Error("Slack isn't connected.");
  // Same key shape as slack/host.ts, so a thread already bound elsewhere is refused before posting.
  const refusal = await deps.core.attachRefusal({
    threadId: request.threadId,
    chatThreadKey:
      request.replyTo === undefined ? undefined : `slack:${request.channel}:${request.replyTo}`,
    replace: false,
  });
  if (refusal !== undefined) throw new Error(refusal);
  // The key replies arrive under: Slack's thread for the post, so a mention there follows up.
  const chatThreadKey = await startConversation(request.channel, request.text, request.replyTo);
  // A `replyTo` that names a reply lands under its root, which may already go to another thread.
  const taken = await deps.core.attachRefusal({
    threadId: request.threadId,
    chatThreadKey,
    replace: false,
  });
  if (taken !== undefined) throw new Error(`Posted, but didn't bind: ${taken}`);
  const channelId = chatThreadKey.split(":")[1] ?? request.channel;
  await deps.core.attach({
    chatThreadKey,
    channelId,
    threadId: request.threadId,
    createdByUserId: "",
    note: (chatKey) => slackWorkNote(chatThreadKey, chatKey),
  });
  return `Started a Slack thread (${chatThreadKey}) for thread ${request.threadId}: replies there continue it, and its final message in each run posts there.`;
}
