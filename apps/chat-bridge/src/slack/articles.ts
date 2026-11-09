/**
 * Office article access for relayed Slack turns, which have no Office chat behind them. Each turn
 * that reaches the agent asks Office for the all-articles capability and stages it as Office turns
 * do. Office decides who gets it; a refusal or a failure leaves the turn running without it.
 */
import type { InboundEvent } from "../bridge.ts";
import type { ArticleFiles } from "../office/article.ts";
import type { OfficeApi } from "../office/client.ts";
import type { ArticleAccess, BridgeStore } from "../store.ts";

/** What Office returns for a Slack message; `null` when the person gets no article access. */
export type SlackArticleGrant = {
  chatId: string;
  runId: string;
  token: string;
  expiresAt: number;
  convexUrl: string;
  instructions: string;
} | null;

export interface SlackArticleHooks {
  readonly prepare: (event: InboundEvent) => Promise<InboundEvent>;
  readonly dispatched: (eventId: string, runId: string) => Promise<void>;
  /** Ends a run's access once it and the delegated work it started have settled. */
  readonly runEnded: (chatThreadKey: string, runId: string) => Promise<void>;
  /** True while someone other than `author` holds live access in these conversations. */
  readonly heldByOther: (chatThreadKeys: ReadonlyArray<string>, author: string) => boolean;
  /**
   * At startup: forgets expired access, and ends access a finished event never handed to a
   * run or whose run was answered with nothing left following its delegated work.
   */
  readonly restore: () => Promise<void>;
}

/** Slack's identity for a person: Office trusts the email only with our team's ID. */
export interface SlackIdentity {
  readonly email?: string | undefined;
  readonly teamId?: string | undefined;
}

const isAside = (text: string) => /^\s*aside\b/i.test(text);

export function slackArticleAccess(options: {
  readonly api: Pick<OfficeApi, "mutate">;
  /** The Office channel's files, read on each call; undefined until Office is set up. */
  readonly articles: () => ArticleFiles | undefined;
  /** The conversation's binding, if any: a follow-up in an unmuted bound thread is a turn too. */
  readonly binding: (chatThreadKey: string) => { readonly muted?: boolean | undefined } | undefined;
  /** Where staged access is kept until Office is told it ended, so a restart still ends it. */
  readonly store: Pick<
    BridgeStore,
    | "stageAccess"
    | "accessDispatched"
    | "articleAccess"
    | "endAccess"
    | "isHandled"
    | "owedDispatches"
    | "isAnswered"
    | "isFollowedRun"
  >;
  /** The person's Slack profile email and team, which Office matches when the Slack ID isn't linked. */
  readonly identity?: ((userId: string) => Promise<SlackIdentity>) | undefined;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}): SlackArticleHooks {
  const { api, log, store } = options;
  const now = options.now ?? Date.now;

  const reachesAgent = (event: InboundEvent) => {
    if (event.contextOnly === true || event.forAnotherBot === true || isAside(event.text))
      return false;
    if (event.addressed) return true;
    const binding = options.binding(event.chatThreadKey);
    return binding !== undefined && binding.muted !== true;
  };

  /** Removes the connections and tells Office the runs ended; the rows go either way. */
  const end = async (accesses: ReadonlyArray<ArticleAccess>, runId?: string) => {
    const chats = new Map<string, Array<string>>();
    for (const access of accesses) {
      const runIds = chats.get(access.chatId) ?? [];
      if (!runIds.includes(access.officeRunId)) runIds.push(access.officeRunId);
      chats.set(access.chatId, runIds);
    }
    for (const [chatId, runIds] of chats) {
      const files = options.articles();
      if (runId !== undefined) await files?.complete(chatId, runId);
      for (const officeRunId of runIds) await files?.discard(chatId, officeRunId);
      await api.mutate("slackArticleAccessEnded", { chatId, runIds }).catch(() => {
        log("Slack: couldn't tell Office an article run ended; its access lapses on its own.");
      });
    }
    for (const access of accesses) store.endAccess(access.eventId);
  };

  return {
    prepare: async (event) => {
      const articles = options.articles();
      if (articles === undefined || !reachesAgent(event)) return event;
      // A retried event is prepared again. Office answers the same message with the run it
      // granted before, so the access the earlier try staged carries on when it still can.
      const staged = store.articleAccess({ eventId: event.eventId });
      const open = staged.find(
        (access) => access.author === event.author.userId && access.expiresAt > now(),
      );
      if (open !== undefined) {
        const note = await articles
          .restage(open.chatId, open.officeRunId, event.eventId)
          .catch(() => undefined);
        if (note !== undefined) {
          return {
            ...event,
            requestNote: [event.requestNote, note].filter(Boolean).join("\n\n"),
          };
        }
      }
      // Anything else staged for it, such as expired access, ends before asking Office again.
      await end(staged);
      // Office trusts the email only with the team ID, so neither is sent alone. Never logged.
      const identity = await options.identity?.(event.author.userId).catch(() => undefined);
      const slack =
        identity?.email && identity.teamId
          ? { slackUserEmail: identity.email, slackUserTeamId: identity.teamId }
          : {};
      try {
        const grant = await api.mutate("slackArticleAccess", {
          chatThreadKey: event.chatThreadKey,
          slackUserId: event.author.userId,
          messageTs: event.messageId,
          text: event.text,
          slackUserName: event.author.fullName || event.author.userName,
          ...slack,
        });
        if (grant === null) return event;
        const { chatId, ...article } = grant;
        store.stageAccess({
          eventId: event.eventId,
          chatThreadKey: event.chatThreadKey,
          author: event.author.userId,
          chatId,
          officeRunId: grant.runId,
          expiresAt: grant.expiresAt,
        });
        const note = await articles.stage(chatId, event.eventId, article);
        return {
          ...event,
          requestNote: [event.requestNote, note].filter(Boolean).join("\n\n"),
        };
      } catch {
        log("Slack: Office article access failed; the turn runs without it.");
        // A grant staged before the failure is ended, so it can't hold the thread.
        await end(store.articleAccess({ eventId: event.eventId }));
        return event;
      }
    },
    dispatched: async (eventId, runId) => {
      if (store.articleAccess({ eventId }).length === 0) return;
      await options.articles()?.dispatched(eventId, runId);
      store.accessDispatched(eventId, runId);
    },
    runEnded: async (_chatThreadKey, runId) => {
      const accesses = store.articleAccess({ runId });
      if (accesses.length > 0) await end(accesses, runId);
    },
    heldByOther: (chatThreadKeys, author) =>
      store
        .articleAccess()
        .some(
          (access) =>
            access.author !== author &&
            access.expiresAt > now() &&
            chatThreadKeys.includes(access.chatThreadKey),
        ),
    restore: async () => {
      for (const access of store.articleAccess()) {
        if (access.expiresAt <= now()) {
          // Office ended it at expiry; ArticleFiles removes the expired file.
          store.endAccess(access.eventId);
          continue;
        }
        if (access.runId !== undefined) {
          // A run still going, or one whose delegated work a follow waits on, is released by
          // that; one answered with nothing following it was missed and ends now.
          if (store.isAnswered(access.runId) && !store.isFollowedRun(access.runId))
            await end([access], access.runId);
          continue;
        }
        // Still on its way to a run: a waiting event reuses it when prepared again, an owed
        // dispatch is sent.
        if (!store.isHandled(access.eventId)) continue;
        const owed = store
          .owedDispatches(access.chatThreadKey)
          .some((each) => each.eventId === access.eventId);
        if (!owed) await end([access]);
      }
    },
  };
}
