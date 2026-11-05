// @effect-diagnostics globalFetch:off -- A plain Node app; it does not use Effect.
/**
 * Linear for the bridge core, on `@chat-adapter/linear` in agent-sessions
 * mode: a session (an @mention, or an issue delegated to the app) is one T3
 * thread, and its follow-up prompts are follow-ups. Runs show as Linear thoughts.
 */
import type { LinearAdapter } from "@chat-adapter/linear";
import type { Chat, Message } from "chat";

import type { InboundEvent, InboundOutcome } from "../bridge.ts";
import type { Deliver } from "../chatHost.ts";
import type { Access, ChannelRoute, ChatPlatform, OutboundFile, ThreadRoute } from "../platform.ts";

/** Linear's context for a session (issue, description, comments) goes into the first turn, cut to this. */
const CONTEXT_CHARS = 20_000;

/** The parts of the Linear SDK client the platform uses. */
export interface LinearApi {
  readonly issue: (
    id: string,
  ) => Promise<{ readonly team: Promise<{ readonly key: string } | undefined> | undefined }>;
  readonly fileUpload: (
    contentType: string,
    filename: string,
    size: number,
  ) => Promise<{
    readonly uploadFile?:
      | {
          readonly uploadUrl: string;
          readonly assetUrl: string;
          readonly headers: ReadonlyArray<{ readonly key: string; readonly value: string }>;
        }
      | undefined;
  }>;
}

/** The issue a Linear thread id (`linear:{issueId}[:c:{commentId}][:s:{sessionId}]`) is on. */
export const issueIdOf = (threadId: string) => threadId.split(":")[1] ?? "";

export function linearEvent(
  threadId: string,
  message: Message,
  kind: InboundEvent["kind"],
  teamKey: string,
  routedTeams: ReadonlySet<string>,
): InboundEvent {
  const raw = message.raw as { readonly agentSessionPromptContext?: string } | undefined;
  const context = kind === "mention" ? (raw?.agentSessionPromptContext ?? "").trim() : "";
  return {
    eventId: `linear:${message.id}`,
    chatThreadKey: threadId,
    // The team routes the thread; a team without a route takes the default one.
    channelId: teamKey,
    messageId: message.id,
    kind,
    addressed: true,
    direct: !routedTeams.has(teamKey),
    author: {
      userId: message.author.userId,
      userName: message.author.userName,
      fullName: message.author.fullName,
    },
    text: context
      ? `${message.text}\n\nLinear's context for this session:\n${context.slice(0, CONTEXT_CHARS)}`
      : message.text,
    files: [],
    mentions: [],
  };
}

/** A file in Linear's storage, as Markdown that shows it in a comment. */
export async function uploadToLinear(api: LinearApi, file: OutboundFile): Promise<string> {
  const contentType = mimeTypeOf(file.filename);
  const upload = (await api.fileUpload(contentType, file.filename, file.data.length)).uploadFile;
  if (upload === undefined) throw new Error(`Linear refused an upload slot for ${file.filename}.`);
  const headers = new Headers({
    "content-type": contentType,
    "cache-control": "public, max-age=31536000",
  });
  for (const { key, value } of upload.headers) headers.set(key, value);
  const put = await fetch(upload.uploadUrl, { method: "PUT", headers, body: file.data });
  if (!put.ok) throw new Error(`Uploading ${file.filename} to Linear failed: ${put.status}.`);
  const label = file.filename.replace(/[[\]]/g, "");
  return contentType.startsWith("image/")
    ? `![${label}](${upload.assetUrl})`
    : `[${label}](${upload.assetUrl})`;
}

const MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

export const mimeTypeOf = (filename: string) =>
  MIME[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

export interface LinearTeamRoute extends ThreadRoute {
  /** The team key, as in issue ids such as ENG-123. */
  readonly team: string;
}

export function linearPlatform(options: {
  readonly chat: () => Chat | undefined;
  readonly adapter: () => Pick<LinearAdapter, "startTyping" | "addReaction"> & {
    readonly linearClient: LinearApi;
  };
  readonly access: Access;
  readonly teams: ReadonlyArray<LinearTeamRoute>;
  readonly defaultRoute: ThreadRoute;
  readonly onEvent: (event: InboundEvent) => Promise<InboundOutcome>;
  readonly log: (line: string) => void;
}): { readonly platform: ChatPlatform; readonly deliver: Deliver } {
  const chat = () => {
    const running = options.chat();
    if (running === undefined) throw new Error("Chat is not running yet.");
    return running;
  };
  const routedTeams = new Set(options.teams.map((route) => route.team.toUpperCase()));
  const teamOfIssue = new Map<string, string>();
  const teamKey = async (issueId: string) => {
    const known = teamOfIssue.get(issueId);
    if (known !== undefined) return known;
    const issue = await options.adapter().linearClient.issue(issueId);
    const key = ((await issue.team)?.key ?? "").toUpperCase();
    teamOfIssue.set(issueId, key);
    return key;
  };
  const deliver: Deliver = async (thread, message, context, route) => {
    const kind = route === "subscribed" ? "follow_up" : "mention";
    // Linear marks a session unresponsive without an activity within seconds; say something first.
    await options
      .adapter()
      .startTyping(thread.id, "Reading the issue")
      .catch((error: unknown) => options.log(`Linear: the first thought failed: ${String(error)}`));
    const team = await teamKey(issueIdOf(thread.id)).catch((error: unknown) => {
      options.log(`Linear: reading the issue's team failed: ${String(error)}`);
      return "";
    });
    for (const each of [...(context?.skipped ?? []), message]) {
      if (each.author.isMe || each.author.isBot === true) continue;
      await options.onEvent(linearEvent(thread.id, each, kind, team, routedTeams));
    }
  };
  const channelRoutes: ReadonlyArray<ChannelRoute> = options.teams.map(({ team, ...route }) => ({
    ...route,
    channelId: team.toUpperCase(),
  }));
  const platform: ChatPlatform = {
    id: "linear",
    name: "Linear",
    place: "Linear agent session",
    access: options.access,
    channelRoutes,
    directRoute: options.defaultRoute,
    person: (userId, name) => (name ? `${name} (Linear user ${userId})` : `Linear user ${userId}`),
    firstTurnNote: (chatKey) =>
      [
        "Your final message in each run is posted to this Linear agent session as its response, in Markdown. Linear shows your progress while you work.",
        "If a message needs no reply, end the run without a final message and nothing is posted.",
        `To attach files or images, call the chat_post tool with chatKey "${chatKey}" and their paths in your workspace; images show inline.`,
        `To react to a comment, call chat_react with chatKey "${chatKey}", the comment id and an emoji name such as thumbs_up, eyes or rocket.`,
      ].join(" "),
    refusal: () => "Sorry, you can't use this agent yet. Ask whoever runs it to allow you.",
    post: async ({ chatThreadKey, text, files }) => {
      const links: Array<string> = [];
      for (const file of files ?? [])
        links.push(await uploadToLinear(options.adapter().linearClient, file));
      const markdown = [text, ...links].filter((part) => part.trim() !== "").join("\n\n");
      if (markdown !== "") await chat().thread(chatThreadKey).post({ markdown });
    },
    react: ({ chatThreadKey, messageId, emoji }) =>
      options.adapter().addReaction(chatThreadKey, messageId, emoji),
    setState: async (chatThreadKey, state, text) => {
      // A thought shows what the run is doing; the response ends the session's turn.
      if (state === "processing" && text !== "") {
        await options.adapter().startTyping(chatThreadKey, text);
      }
    },
    bound: async (chatThreadKey) => {
      await chat().thread(chatThreadKey).subscribe();
    },
  };
  return { platform, deliver };
}
