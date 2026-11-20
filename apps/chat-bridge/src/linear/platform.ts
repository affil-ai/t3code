// @effect-diagnostics globalFetch:off globalTimers:off -- A plain Node app; it does not use Effect.
/**
 * Linear for the bridge core, in agent-sessions mode. An issue is one T3
 * thread: every session on it continues that thread, and replies go to the
 * session the latest prompt came from. Plain comments are context only.
 */
import type { LinearAdapter } from "@chat-adapter/linear";
import type { Chat, Message } from "chat";

import type { PlanStep } from "../activity.ts";
import type { InboundEvent, InboundOutcome } from "../bridge.ts";
import type { Deliver } from "../chatHost.ts";
import { mimeTypeOf } from "../fileMimeType.ts";
export { mimeTypeOf } from "../fileMimeType.ts";
import {
  type Access,
  type ChannelRoute,
  type ChatPlatform,
  type OutboundFile,
  QUIET_REPLY,
  QUIET_RULES,
  type ThreadRoute,
} from "../platform.ts";
import { downloadUpload, takeUploads, uploadEventFiles, withoutUploadLinks } from "./files.ts";
import { type Retry, noRetry } from "./startup.ts";
import type { LinearComment } from "./stop.ts";

/**
 * A comment that starts or continues a session reaches the bridge twice: as
 * the session's prompt and as a plain comment, in either order. A plain
 * comment waits this long, so the prompt can claim it first.
 */
const COMMENT_GRACE_MS = 15_000;

/** Linear's context for a session (issue, description, comments) goes into the first turn, cut to this. */
const CONTEXT_CHARS = 20_000;

/** The parts of the Linear SDK client the platform uses. */
export interface LinearApi {
  readonly issue: (id: string) => Promise<{
    readonly id?: string;
    readonly identifier?: string;
    readonly url?: string;
    readonly team: Promise<{ readonly key: string } | undefined> | undefined;
  }>;
  /** For work an orchestrator starts: finding a team, making an issue, opening a session on it. */
  readonly teams?: (variables: {
    readonly filter: { readonly key: { readonly eq: string } };
  }) => Promise<{ readonly nodes: ReadonlyArray<{ readonly id: string; readonly key: string }> }>;
  readonly createIssue?: (input: {
    readonly teamId: string;
    readonly title: string;
    readonly description?: string;
  }) => Promise<{ readonly issueId?: string | undefined }>;
  readonly agentSessionCreateOnIssue?: (input: {
    readonly issueId: string;
  }) => Promise<{ readonly agentSessionId?: string | undefined }>;
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
    /** Such as "active" while the agent works, or "complete" after a response. */
    readonly status?: string;
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
/** The response that ends a session whose run chose not to answer. */
export const QUIET_DONE = "Done, nothing to add.";

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

/** A plain comment on the issue, kept as context and never answered. */
export function commentEvent(comment: LinearComment): InboundEvent {
  const { text, uploads } = takeUploads(comment.body);
  return {
    // The id a session prompt from the same comment would have, so only one of them counts.
    eventId: `linear:${comment.id}`,
    chatThreadKey: `linear:${comment.issueId}`,
    channelId: "",
    messageId: comment.id,
    kind: "follow_up",
    addressed: false,
    direct: false,
    contextOnly: true,
    author: { userId: comment.userId, userName: comment.name, fullName: comment.name },
    text,
    files: uploadEventFiles(uploads),
    mentions: [],
  };
}

/** What chat_react answers on Linear. */
export const REACTIONS_UNSEEN =
  "Not reacted: Linear doesn't show reactions on session messages. Acknowledge in words instead, in your reply or with a short chat_post update while you work.";

/**
 * "ENG-123 Issue title" from Linear's session context, which starts with
 * `<issue identifier="ENG-123">` and a `<title>`. A delegated issue's prompt is
 * only Linear's "This thread is for an agent session with …", so the thread is
 * named after the issue instead.
 */
export function issueTitle(context: string): string | undefined {
  const identifier = /<issue\b[^>]*\bidentifier="([^"]+)"/.exec(context)?.[1];
  const title = /<title>([\s\S]*?)<\/title>/.exec(context)?.[1]?.replace(/\s+/g, " ").trim();
  if (!identifier && !title) return undefined;
  return [identifier, title].filter(Boolean).join(" ");
}

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
  const title = kind === "mention" ? issueTitle(raw?.agentSessionPromptContext ?? "") : undefined;
  return {
    ...(title === undefined ? {} : { title }),
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

/** An issue an orchestrator's subagent works on. */
export interface LinearIssueRef {
  readonly issueId: string;
  readonly identifier: string;
  readonly url: string;
  readonly teamKey: string;
}

export interface LinearTeamRoute extends ThreadRoute {
  /** The team key, as in issue ids such as ENG-123. */
  readonly team: string;
}

export function linearPlatform(options: {
  readonly chat: () => Chat | undefined;
  readonly adapter: () => Pick<LinearAdapter, "startTyping"> & {
    readonly botUserId?: string | undefined;
    readonly linearClient: LinearApi;
  };
  readonly access: Access;
  readonly teams: ReadonlyArray<LinearTeamRoute>;
  readonly defaultRoute: ThreadRoute;
  readonly onEvent: (event: InboundEvent) => Promise<InboundOutcome>;
  readonly log: (line: string) => void;
  /** Gets a new token and retries once when Linear says the bridge isn't signed in. */
  readonly retry?: Retry;
  /** How the bot is @mentioned, such as "office"; a comment mentioning it is a session's. */
  readonly botName?: string;
  /** Waits before a plain comment counts; tests pass a shorter wait. */
  readonly commentGrace?: () => Promise<void>;
  /** Sessions the bridge opened itself, whose `created` event is not a prompt. Kept across restarts. */
  readonly ownSessions?: {
    readonly has: (sessionId: string) => boolean;
    readonly add: (sessionId: string) => void;
  };
  /** Whether the core already handled an event, such as before a restart. */
  readonly isHandled?: (eventId: string) => boolean;
  /** Each issue's latest session thread, kept across restarts so owed replies still find it. */
  readonly sessions?: {
    readonly get: (issueKey: string) => string | undefined;
    readonly set: (issueKey: string, sessionThreadId: string) => void;
  };
}): {
  readonly platform: ChatPlatform;
  readonly deliver: Deliver;
  /** Keeps a plain comment as context for its issue's conversation, unless a session took it. */
  readonly comment: (comment: LinearComment) => Promise<void>;
  /** An existing issue, by identifier such as ENG-123. Reads only. */
  readonly findIssue: (identifier: string) => Promise<LinearIssueRef>;
  readonly createIssue: (input: {
    readonly team: string;
    readonly title: string;
    readonly description?: string | undefined;
  }) => Promise<LinearIssueRef>;
  /** Opens an agent session on the issue, which the issue's answers go to from now on. */
  readonly openSession: (issue: LinearIssueRef) => Promise<string>;
  /** What a subagent is told when its work becomes the issue's. */
  readonly workNote: (issue: LinearIssueRef, chatKey: string) => string;
} {
  const retry = options.retry ?? noRetry;
  /** Links to files the agent sent mid-run, by conversation, until the run's reply carries them. */
  const heldFiles = new Map<string, ReadonlyArray<string>>();
  const takeHeld = (chatThreadKey: string): ReadonlyArray<string> => {
    const held = heldFiles.get(chatThreadKey) ?? [];
    heldFiles.delete(chatThreadKey);
    return held;
  };
  const ownSessionIds = new Set<string>();
  const ownSessions = options.ownSessions ?? {
    has: (id: string) => ownSessionIds.has(id),
    add: (id: string) => void ownSessionIds.add(id),
  };
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
      // Linear writes the first prompt of a session the bridge opened as the app itself.
      const author = activity.userId ?? "";
      if (author === "" || author === options.adapter().botUserId) continue;
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
    const ownSession = sessionIdOf(thread.id);
    // A session the bridge opened announces itself; its work already has a thread.
    if (
      ownSession !== undefined &&
      ownSessions.has(ownSession) &&
      message.id === `agent-session-${ownSession}`
    ) {
      return;
    }
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
  const grace =
    options.commentGrace ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, COMMENT_GRACE_MS).unref()));
  const mention =
    options.botName === undefined
      ? undefined
      : new RegExp(`@${options.botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const comment = async (each: LinearComment): Promise<void> => {
    if (each.userId === options.adapter().botUserId) return;
    // An @mention, or a reply under a session's comment, is that session's prompt.
    if (mention?.test(each.body)) return;
    await grace();
    if (known(`linear:${each.id}`)) return;
    // A reply under a comment that opened a session goes to that session, even if late.
    if (each.parentId !== undefined && handedOver.has(`linear:${each.parentId}`)) return;
    await options.onEvent(commentEvent(each));
  };
  const channelRoutes: ReadonlyArray<ChannelRoute> = options.teams.map(({ team, ...route }) => ({
    ...route,
    channelId: team.toUpperCase(),
  }));
  const firstTurn = (chatKey: string): string =>
    [
      "This thread is the Linear issue's conversation: every agent session and @mention of you on the issue continues it, so earlier sessions' messages are yours too.",
      "Your final message in each run is posted, in Markdown, as the response in the session the latest message came from. Linear shows your progress while you work.",
      QUIET_RULES,
      "Files and images people attach in Linear arrive as files in your turn.",
      `To attach files or images, call the chat_post tool with chatKey "${chatKey}" and their paths in your workspace; they appear with your final message, and images show inline.`,
      "Linear doesn't show reactions on session messages, so acknowledge in words, or with a short chat_post update while you work.",
    ].join(" ");
  const platform: ChatPlatform = {
    id: "linear",
    name: "Linear",
    place: "Linear issue's latest agent session",
    access: options.access,
    channelRoutes,
    directRoute: options.defaultRoute,
    person: (userId, name) => (name ? `${name} (Linear user ${userId})` : `Linear user ${userId}`),
    firstTurnNote: (chatKey) => firstTurn(chatKey),
    refusal: () => "Sorry, you can't use this agent yet. Ask whoever runs it to allow you.",
    post: async ({ chatThreadKey, text, files, kind = "answer", choices }) => {
      const links: Array<string> = [];
      for (const file of files ?? []) links.push(await retry(() => uploadToLinear(client(), file)));
      if (kind === "update" && links.length > 0) {
        // Files sent mid-run go with the run's reply, not under its collapsed work.
        heldFiles.set(chatThreadKey, [...(heldFiles.get(chatThreadKey) ?? []), ...links]);
        if (text.trim() !== "") await activity(chatThreadKey, { type: "thought", body: text });
        return;
      }
      const held = kind === "answer" ? takeHeld(chatThreadKey) : [];
      const markdown = [text, ...links, ...held].filter((part) => part.trim() !== "").join("\n\n");
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
    // Linear accepts a reaction on a session prompt but shows it nowhere.
    reactionsUnseen: REACTIONS_UNSEEN,
    setState: async (chatThreadKey, state, text) => {
      // A thought shows what the run is doing; the response ends the session's turn.
      if (state === "processing" && text !== "") {
        await options.adapter().startTyping(sessionThread(chatThreadKey), text);
        return;
      }
      // The run ended without a reply to carry its files: they are the response.
      const held = state === "active" ? takeHeld(chatThreadKey) : [];
      if (held.length > 0) {
        await chat()
          .thread(sessionThread(chatThreadKey))
          .post({ markdown: held.join("\n\n") });
      }
    },
    // A session stays active, showing the agent at work, until a response ends it.
    quiet: async (chatThreadKey) => {
      const thread = sessionThread(chatThreadKey);
      const agentSessionId = sessionIdOf(thread);
      if (agentSessionId === undefined) return;
      const { status } = await retry(() => client().agentSession(agentSessionId));
      if (status !== "active" && status !== "pending") return;
      const held = takeHeld(chatThreadKey);
      await chat()
        .thread(thread)
        .post({ markdown: held.length > 0 ? held.join("\n\n") : QUIET_DONE });
      options.log(`Linear: session ${agentSessionId} was ${status} after a quiet run; ended it.`);
    },
    bound: async (chatThreadKey) => {
      await chat().thread(sessionThread(chatThreadKey)).subscribe();
    },
  };
  const linearApi = (name: "teams" | "createIssue" | "agentSessionCreateOnIssue") => {
    const api = client();
    if (api[name] === undefined) throw new Error(`This Linear client can't ${name}.`);
    return api;
  };
  const refOf = async (issue: Awaited<ReturnType<LinearApi["issue"]>>): Promise<LinearIssueRef> => {
    const team = await issue.team;
    if (!issue.id || !issue.identifier || !issue.url || team === undefined) {
      throw new Error("Linear didn't say which issue that is.");
    }
    return { issueId: issue.id, identifier: issue.identifier, url: issue.url, teamKey: team.key };
  };
  const findIssue = async (identifier: string) =>
    refOf(await retry(() => client().issue(identifier)));
  const createIssue = async (input: {
    readonly team: string;
    readonly title: string;
    readonly description?: string | undefined;
  }) => {
    const key = input.team.toUpperCase();
    const { nodes } = await retry(() =>
      linearApi("teams").teams!({ filter: { key: { eq: key } } }),
    );
    const team = nodes[0];
    if (team === undefined) throw new Error(`Linear has no team ${key}.`);
    const created = await retry(() =>
      linearApi("createIssue").createIssue!({
        teamId: team.id,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
      }),
    );
    if (!created.issueId) throw new Error("Linear didn't return the new issue.");
    const ref = await findIssue(created.issueId);
    options.log(`Linear: created ${ref.identifier} for an orchestrator.`);
    return ref;
  };
  const openSession = async (issue: LinearIssueRef) => {
    const opened = await retry(() =>
      linearApi("agentSessionCreateOnIssue").agentSessionCreateOnIssue!({
        issueId: issue.issueId,
      }),
    );
    const sessionId = opened.agentSessionId;
    if (!sessionId) throw new Error(`Linear didn't open a session on ${issue.identifier}.`);
    ownSessions.add(sessionId);
    const threadId = `linear:${issue.issueId}:s:${sessionId}`;
    sessions.set(`linear:${issue.issueId}`, threadId);
    // Linear marks a session unresponsive without an activity within seconds.
    await options
      .adapter()
      .startTyping(threadId, "Working in T3")
      .catch((error: unknown) => options.log(`Linear: the first thought failed: ${String(error)}`));
    options.log(`Linear: opened session ${sessionId} on ${issue.identifier}.`);
    return threadId;
  };
  const workNote = (issue: LinearIssueRef, chatKey: string) =>
    [
      `Your work is now Linear issue ${issue.identifier} (${issue.url}): its agent session shows your progress, and your final message is posted there.`,
      firstTurn(chatKey),
      `If you had already finished when this arrived, answer ${QUIET_REPLY}.`,
      `Chat key: ${chatKey}`,
    ].join("\n\n");
  return { platform, deliver, comment, findIssue, createIssue, openSession, workNote };
}
