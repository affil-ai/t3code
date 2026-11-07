/**
 * What the core needs from a chat platform beyond Chat SDK: access, routes,
 * how it reads to the agent, and optional extras. Chat thread keys start with
 * the platform id and a colon (`slack:…`, `imessage:42`).
 */
import type { PlanStep, RunStep } from "./activity.ts";
import type { EarlierMessage, InboundEvent, SessionState } from "./bridge.ts";

/** Where a new thread goes: a T3 project, and optionally a new worktree. */
export interface ThreadRoute {
  readonly projectId: string;
  /** Start each thread in a new worktree from this branch on origin, such as "dev". Without it, the project's checkout. */
  readonly worktreeFrom?: string | undefined;
  /** Added to the thread's first turn, such as limits on what the agent may run. */
  readonly note?: string | undefined;
}

/** A channel's route. A channel may have several; the first that matches wins. */
export interface ChannelRoute extends ThreadRoute {
  readonly channelId: string;
  /** Only messages containing this text, any case, such as "[nextcard]". Without it, any message. */
  readonly match?: string | undefined;
}

/** Who may use the bot on one platform. */
export interface Access {
  /** Always allowed. */
  readonly allowedUserIds: ReadonlyArray<string>;
  /** Also allow everyone the platform counts as eligible; see `ChatPlatform.isEligible`. */
  readonly allowEveryone?: boolean | undefined;
}

export interface OutboundFile {
  readonly data: Buffer;
  readonly filename: string;
}

/**
 * What a message is for: the run's final `answer` (or a notice ending the
 * exchange), a `question` that waits for the person, or an `update` mid-run.
 * Linear ends a session's turn only on an answer; others post all alike.
 */
export type OutboundKind = "answer" | "question" | "update";

export interface OutboundMessage {
  /** Stable delivery identity, independent of the message text. */
  readonly eventId?: string | undefined;
  readonly chatThreadKey: string;
  readonly text: string;
  readonly files?: ReadonlyArray<OutboundFile> | undefined;
  /** Without it, an answer. */
  readonly kind?: OutboundKind | undefined;
  /** A question's options, for platforms that offer them to pick; `text` has them numbered. */
  readonly choices?:
    | { readonly question: string; readonly options: ReadonlyArray<string> }
    | undefined;
}

/**
 * A final message that is only this posts nothing. Claude Code answers a run
 * that ends with no text by asking for a visible reply, so ending silently
 * isn't enough to stay quiet.
 */
export const QUIET_REPLY = "NO_REPLY";

/** True for a final message that asks to post nothing, allowing stray quotes, backticks or a full stop. */
export const isQuietReply = (text: string): boolean =>
  text.trim().replace(/^[`"']+|[`"'.]+$/g, "") === QUIET_REPLY;

/** How the agent stays quiet, and how to treat wake-ups from its subagents and background work. */
export const QUIET_RULES = [
  `If a run needs no reply, make your whole final message exactly ${QUIET_REPLY} and nothing is posted.`,
  "A subagent or background command can wake you more than once, and a wake can come before its work is done. Post each result once: when a wake only repeats what you already posted, or only says the work is still going, answer " +
    QUIET_REPLY +
    ".",
].join(" ");

export interface Reaction {
  readonly chatThreadKey: string;
  /** The message id the turn showed. */
  readonly messageId: string;
  /** An emoji name without colons, such as `eyes`. */
  readonly emoji: string;
}

/** A message the bridge posts with blocks, such as a question with buttons. */
export interface BlockMessage {
  readonly chatThreadKey: string;
  /** Shown in notifications, and where blocks can't be. */
  readonly text: string;
  readonly blocks: ReadonlyArray<Record<string, unknown>>;
}

export interface ChatPlatform {
  /** The chat thread key prefix, such as "slack". */
  readonly id: string;
  /** As people and agents know it, such as "Slack". */
  readonly name: string;
  /** What one conversation is called, such as "Slack thread" or "iMessage conversation". */
  readonly place: string;
  readonly access: Access;
  /**
   * With `allowEveryone`, whether this person counts, such as a full member
   * of the Slack workspace. Without it, everyone counts.
   */
  readonly isEligible?: (userId: string) => Promise<boolean>;
  /** Routes for messages outside a bound thread that aren't direct. */
  readonly channelRoutes?: ReadonlyArray<ChannelRoute>;
  /** Where a new direct conversation starts. Without it, new direct conversations are ignored. */
  readonly directRoute?: ThreadRoute | undefined;

  /** A person as the agent sees them in a turn, with whatever it needs to mention them. */
  readonly person: (userId: string, name: string) => string;
  /** How the agent's answers reach the conversation and how it uses the chat tools, once per thread. */
  readonly firstTurnNote: (chatKey: string, event: InboundEvent) => string;
  /** Why someone can't use the bot, and what to ask for. */
  readonly refusal: (userId: string) => string;
  /** Refreshes request context just before handoff, without saving it to the inbox. Undefined rejects it. */
  readonly prepare?: (event: InboundEvent) => Promise<InboundEvent | undefined>;
  /** Associates prepared resources with the accepted run, including steers. */
  readonly dispatched?: (event: InboundEvent, runId: string) => Promise<void>;
  /** Releases resources for this run without touching a concurrent run's resources. */
  readonly runEnded?: (chatThreadKey: string, runId: string) => Promise<void>;

  /** Posts an answer or a notice. */
  readonly post: (message: OutboundMessage) => Promise<void>;
  /** Reacts to a message; absent when the platform can't. */
  readonly react?: (reaction: Reaction) => Promise<void>;
  /**
   * Where reactions exist but nobody sees them, what `chat_react` tells the
   * agent instead of reacting, such as how else to acknowledge.
   */
  readonly reactionsUnseen?: string;
  /**
   * Posts a question with buttons and returns its message id. Without it,
   * questions are posted as text and answered by replying.
   */
  readonly postBlocks?: (message: BlockMessage) => Promise<string>;
  /** Replaces a message posted with `postBlocks`. */
  readonly updateBlocks?: (message: BlockMessage & { readonly messageId: string }) => Promise<void>;
  /** Shows the conversation's agent state, and what it is doing while it processes. */
  readonly setState?: (chatThreadKey: string, state: SessionState, text: string) => Promise<void>;
  /** Lists one finished step of the run, such as a command it ran; absent where steps show only as the state's text. */
  readonly step?: (chatThreadKey: string, step: RunStep) => Promise<void>;
  /** Shows the run's to-do list, replaced whole on each change; absent where it isn't shown. */
  readonly plan?: (chatThreadKey: string, steps: ReadonlyArray<PlanStep>) => Promise<void>;
  /** Sets the conversation's title to the T3 thread's. */
  readonly rename?: (chatThreadKey: string, title: string) => Promise<void>;
  /** Downloads a file on an inbound message. Without it, files are named but not imported. */
  readonly download?: (url: string) => Promise<Uint8Array>;
  /** The messages before `messageId`, oldest first, read when a message starts a binding. */
  readonly history?: (
    chatThreadKey: string,
    messageId: string,
  ) => Promise<ReadonlyArray<EarlierMessage>>;
  /**
   * Starts a new conversation for a thread that asks for one, such as a Slack
   * thread under an opening message, and returns its chat thread key.
   */
  readonly startConversation?: (where: string, text: string) => Promise<string>;
  /**
   * A run ended without an answer: `NO_REPLY` or no final message. Ends
   * anything still waiting on one, such as a Linear session showing the
   * agent at work.
   */
  readonly quiet?: (chatThreadKey: string) => Promise<void>;
  /** Called once a conversation is bound, so the platform can follow it. */
  readonly bound?: (chatThreadKey: string) => Promise<void>;
}

/** The platform a chat thread key belongs to. */
export function platformFor(
  platforms: ReadonlyArray<ChatPlatform>,
  chatThreadKey: string,
): ChatPlatform {
  const id = chatThreadKey.slice(0, chatThreadKey.indexOf(":"));
  const platform = platforms.find((each) => each.id === id);
  if (platform === undefined) throw new Error(`No chat platform for ${chatThreadKey}.`);
  return platform;
}
