// @effect-diagnostics globalFetch:off -- A plain Node app; it does not use Effect.
/**
 * Linear for the bridge core, in agent-sessions mode. An issue is one T3
 * thread: every session on it (each @mention or delegation) continues that
 * thread, and replies go to the session the latest prompt came from. A run
 * shows as thoughts for status, an action per step and a response for the answer.
 */
import type { LinearAdapter } from "@chat-adapter/linear";
import type { Chat, Message } from "chat";

import type { PlanStep } from "../activity.ts";
import type { InboundEvent, InboundOutcome } from "../bridge.ts";
import type { Deliver } from "../chatHost.ts";
import type { Access, ChannelRoute, ChatPlatform, OutboundFile, ThreadRoute } from "../platform.ts";
import { downloadUpload, takeUploads, uploadEventFiles, withoutUploadLinks } from "./files.ts";
import { type Retry, noRetry } from "./startup.ts";

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
  readonly createAgentActivity: (input: {
    readonly agentSessionId: string;
    readonly content: Readonly<Record<string, string>>;
    readonly ephemeral?: boolean;
    readonly signal?: "select";
    readonly signalMetadata?: Readonly<Record<string, unknown>>;
  }) => Promise<unknown>;
  readonly updateAgentSession: (
    id: string,
    input: {
      readonly plan: ReadonlyArray<{ readonly content: string; readonly status: LinearPlanStatus }>;
    },
  ) => Promise<unknown>;
  readonly agentSession: (id: string) => Promise<{
    readonly activities: (variables: { readonly last: number }) => Promise<{
      readonly nodes: ReadonlyArray<SessionActivity>;
    }>;
  }>;
  /** The SDK client's options, which hold the current `Authorization` header. */
  readonly options?: { readonly headers?: Readonly<Record<string, string>> } | undefined;
}

/** Linear's statuses for a step of a session's plan. */
export type LinearPlanStatus = "pending" | "inProgress" | "completed" | "canceled";

/** The parts of a session activity the bridge reads to find prompts it never got. */
export interface SessionActivity {
  readonly id: string;
  readonly createdAt: Date;
  readonly content: {
    readonly __typename?: string;
    readonly type?: string;
    readonly body?: string;
  };
  readonly sourceCommentId?: string | undefined;
  readonly userId?: string | undefined;
  readonly user?:
    | PromiseLike<{ readonly name?: string; readonly displayName?: string } | undefined>
    | undefined;
}

const PLAN_STATUS: Readonly<Record<PlanStep["status"], LinearPlanStatus>> = {
  pending: "pending",
  running: "inProgress",
  completed: "completed",
};

/** Prompts read back from a session per delivery; a burst bigger than this is rare. */
const RECONCILE_LAST = 20;

/** The issue a Linear thread id (`linear:{issueId}[:c:{commentId}][:s:{sessionId}]`) is on. */
export const issueIdOf = (threadId: string) => threadId.split(":")[1] ?? "";

/** The core's key for an issue's conversation, shared by all its sessions. */
export const issueKeyOf = (threadId: string) => `linear:${issueIdOf(threadId)}`;

/** The agent session a Linear thread id is in, if any. */
export const sessionIdOf = (threadId: string): string | undefined => {
  const parts = threadId.split(":");
  const at = parts.indexOf("s");
  return at > 0 ? parts[at + 1] : undefined;
};

export function linearEvent(
  threadId: string,
  message: Message,
  kind: InboundEvent["kind"],
  teamKey: string,
  routedTeams: ReadonlySet<string>,
): InboundEvent {
  const raw = message.raw as
    | {
        readonly agentSessionPromptContext?: string;
        readonly comment?: { readonly body?: string };
      }
    | undefined;
  // Files come from the prompt's Markdown; the agent gets them as files, never their signed links.
  const { uploads } = takeUploads(raw?.comment?.body ?? "");
  const context =
    kind === "mention" ? withoutUploadLinks((raw?.agentSessionPromptContext ?? "").trim()) : "";
  const text = takeUploads(message.text).text;
  return {
    eventId: `linear:${message.id}`,
    chatThreadKey: issueKeyOf(threadId),
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
      ? `${text}\n\nLinear's context for this session:\n${context.slice(0, CONTEXT_CHARS)}`
      : text,
    files: uploadEventFiles(uploads),
    mentions: [],
  };
}

/**
 * A prompt Linear shows in the session that never reached the bridge, such as
 * when its webhook was lost, as a follow-up.
 */
export function missedPromptEvent(
  threadId: string,
  prompt: {
    readonly id: string;
    readonly body: string;
    readonly userId: string;
    readonly name: string;
  },
  teamKey: string,
  routedTeams: ReadonlySet<string>,
): InboundEvent {
  const { text, uploads } = takeUploads(prompt.body);
  return {
    eventId: `linear:${prompt.id}`,
    chatThreadKey: issueKeyOf(threadId),
    channelId: teamKey,
    messageId: prompt.id,
    kind: "follow_up",
    addressed: true,
    direct: !routedTeams.has(teamKey),
    author: { userId: prompt.userId, userName: prompt.name, fullName: prompt.name },
    text,
    files: uploadEventFiles(uploads),
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
  /** Gets a new token and retries once when Linear says the bridge isn't signed in. */
  readonly retry?: Retry;
  /** Whether the core already handled an event, such as before a restart. */
  readonly isHandled?: (eventId: string) => boolean;
  /** Each issue's latest session thread, kept across restarts so owed replies still find it. */
  readonly sessions?: {
    readonly get: (issueKey: string) => string | undefined;
    readonly set: (issueKey: string, sessionThreadId: string) => void;
  };
}): { readonly platform: ChatPlatform; readonly deliver: Deliver } {
  const retry = options.retry ?? noRetry;
  const latestSession = new Map<string, string>();
  const sessions = options.sessions ?? {
    get: (issueKey: string) => latestSession.get(issueKey),
    set: (issueKey: string, threadId: string) => void latestSession.set(issueKey, threadId),
  };
  /**
   * The Chat SDK thread to answer in: the session the issue's latest prompt
   * came from. A key that is already a session thread (from before issues
   * shared a thread) answers there.
   */
  const sessionThread = (chatThreadKey: string): string => {
    if (sessionIdOf(chatThreadKey) !== undefined) return chatThreadKey;
    const latest = sessions.get(chatThreadKey);
    if (latest === undefined) throw new Error(`No Linear session for ${chatThreadKey} yet.`);
    return latest;
  };
  const client = () => options.adapter().linearClient;
  /** An activity in the thread's session; false outside a session. */
  const activity = async (
    chatThreadKey: string,
    content: Readonly<Record<string, string>>,
    signal?: { readonly signal: "select"; readonly signalMetadata: Record<string, unknown> },
  ): Promise<boolean> => {
    const agentSessionId = sessionIdOf(sessionThread(chatThreadKey));
    if (agentSessionId === undefined) return false;
    await retry(() => client().createAgentActivity({ agentSessionId, content, ...signal }));
    return true;
  };
  /**
   * A question with options, as Linear's own chooser. A pick comes back as a
   * prompt with the label, which the core takes as the answer. False when
   * Linear refuses it, so the numbered text is asked instead.
   */
  const askToPick = async (
    chatThreadKey: string,
    choices: { readonly question: string; readonly options: ReadonlyArray<string> },
  ): Promise<boolean> =>
    activity(
      chatThreadKey,
      { type: "elicitation", body: choices.question },
      {
        signal: "select",
        signalMetadata: { options: choices.options.map((label) => ({ label, value: label })) },
      },
    ).catch((error: unknown) => {
      options.log(
        `Linear refused a question with options; asking it as numbered text: ${String(error)}`,
      );
      return false;
    });
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
    const issue = await retry(() => client().issue(issueId));
    const key = ((await issue.team)?.key ?? "").toUpperCase();
    teamOfIssue.set(issueId, key);
    return key;
  };
  /** Event ids handed to the core by this process, on top of what the core's store has handled. */
  const handedOver = new Set<string>();
  const known = (eventId: string) =>
    handedOver.has(eventId) || (options.isHandled?.(eventId) ?? false);
  /**
   * Prompts in the session older than `message` that never reached the
   * bridge, oldest first; a webhook can be lost, and nothing else would tell us.
   */
  const missedPrompts = async (
    threadId: string,
    message: Message,
    team: string,
  ): Promise<ReadonlyArray<InboundEvent>> => {
    const sessionId = sessionIdOf(threadId);
    if (sessionId === undefined) return [];
    const session = await retry(() => client().agentSession(sessionId));
    const { nodes } = await retry(() => session.activities({ last: RECONCILE_LAST }));
    const missed: Array<InboundEvent> = [];
    for (const activity of [...nodes].toSorted(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    )) {
      const prompt =
        activity.content.__typename === "AgentActivityPromptContent" ||
        activity.content.type === "prompt";
      const id = activity.sourceCommentId ?? activity.id;
      if (!prompt || id === message.id || known(`linear:${id}`)) continue;
      if (activity.createdAt.getTime() >= message.metadata.dateSent.getTime()) continue;
      const user = await activity.user;
      missed.push(
        missedPromptEvent(
          threadId,
          {
            id,
            body: activity.content.body ?? "",
            userId: activity.userId ?? "",
            name: user?.name ?? user?.displayName ?? "",
          },
          team,
          routedTeams,
        ),
      );
    }
    return missed;
  };
  const deliver: Deliver = async (thread, message, context, route) => {
    const kind = route === "subscribed" ? "follow_up" : "mention";
    // Replies go where the person last asked.
    sessions.set(issueKeyOf(thread.id), thread.id);
    // Linear marks a session unresponsive without an activity within seconds; say something
    // first, without holding up the hand-off.
    void options
      .adapter()
      .startTyping(thread.id, "Reading the issue")
      .catch((error: unknown) => options.log(`Linear: the first thought failed: ${String(error)}`));
    const team = await teamKey(issueIdOf(thread.id)).catch((error: unknown) => {
      options.log(`Linear: reading the issue's team failed: ${String(error)}`);
      return "";
    });
    const missed =
      kind === "follow_up"
        ? await missedPrompts(thread.id, message, team).catch((error: unknown) => {
            options.log(`Linear: reading the session's prompts failed: ${String(error)}`);
            return [];
          })
        : [];
    const events = [
      ...missed,
      ...[...(context?.skipped ?? []), message]
        .filter((each) => !each.author.isMe && each.author.isBot !== true)
        .map((each) => linearEvent(thread.id, each, kind, team, routedTeams)),
    ];
    for (const event of events) {
      if (missed.includes(event)) {
        options.log(
          `Linear: ${event.eventId} is in the session but hadn't reached the bridge; handing it over.`,
        );
      }
      handedOver.add(event.eventId);
      await options.onEvent(event);
    }
  };
  const channelRoutes: ReadonlyArray<ChannelRoute> = options.teams.map(({ team, ...route }) => ({
    ...route,
    channelId: team.toUpperCase(),
  }));
  const platform: ChatPlatform = {
    id: "linear",
    name: "Linear",
    place: "Linear issue's latest agent session",
    access: options.access,
    channelRoutes,
    directRoute: options.defaultRoute,
    person: (userId, name) => (name ? `${name} (Linear user ${userId})` : `Linear user ${userId}`),
    firstTurnNote: (chatKey) =>
      [
        "This thread is the Linear issue's conversation: every agent session and @mention of you on the issue continues it, so earlier sessions' messages are yours too.",
        "Your final message in each run is posted, in Markdown, as the response in the session the latest message came from. Linear shows your progress while you work.",
        "If a message needs no reply, end the run without a final message and nothing is posted.",
        "Files and images people attach in Linear arrive as files in your turn.",
        `To attach files or images, call the chat_post tool with chatKey "${chatKey}" and their paths in your workspace; images show inline.`,
        `To react to a comment, call chat_react with chatKey "${chatKey}", the comment id and an emoji name such as thumbs_up, eyes or rocket.`,
      ].join(" "),
    refusal: () => "Sorry, you can't use this agent yet. Ask whoever runs it to allow you.",
    post: async ({ chatThreadKey, text, files, kind = "answer", choices }) => {
      const links: Array<string> = [];
      for (const file of files ?? []) links.push(await retry(() => uploadToLinear(client(), file)));
      const markdown = [text, ...links].filter((part) => part.trim() !== "").join("\n\n");
      if (markdown === "") return;
      // Only the answer is a response, which ends the session's turn; a question waits for the person.
      if (
        kind === "question" &&
        choices !== undefined &&
        links.length === 0 &&
        (await askToPick(chatThreadKey, choices))
      ) {
        return;
      }
      if (
        kind === "question" &&
        (await activity(chatThreadKey, { type: "elicitation", body: markdown }))
      )
        return;
      if (kind === "update" && (await activity(chatThreadKey, { type: "thought", body: markdown })))
        return;
      await chat().thread(sessionThread(chatThreadKey)).post({ markdown });
    },
    plan: async (chatThreadKey, steps) => {
      const agentSessionId = sessionIdOf(sessionThread(chatThreadKey));
      if (agentSessionId === undefined) return;
      // Linear replaces the plan whole on each update.
      await retry(() =>
        client().updateAgentSession(agentSessionId, {
          plan: steps.map((step) => ({ content: step.text, status: PLAN_STATUS[step.status] })),
        }),
      );
    },
    step: async (chatThreadKey, step) => {
      await activity(chatThreadKey, {
        type: "action",
        action: step.action,
        parameter: step.parameter,
        result: step.result,
      });
    },
    download: (url) =>
      retry(() =>
        downloadUpload(url, {
          authorization: () => client().options?.headers?.Authorization ?? "",
        }),
      ),
    react: ({ chatThreadKey, messageId, emoji }) =>
      options.adapter().addReaction(sessionThread(chatThreadKey), messageId, emoji),
    setState: async (chatThreadKey, state, text) => {
      // A thought shows what the run is doing; the response ends the session's turn.
      if (state === "processing" && text !== "") {
        await options.adapter().startTyping(sessionThread(chatThreadKey), text);
      }
    },
    bound: async (chatThreadKey) => {
      await chat().thread(sessionThread(chatThreadKey)).subscribe();
    },
  };
  return { platform, deliver };
}
