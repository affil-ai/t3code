/**
 * Office article access for relayed Slack turns, which have no Office chat behind them. Each turn
 * that reaches the agent asks Office for the all-articles capability and stages it as Office turns
 * do. Office decides who gets it; a refusal or a failure leaves the turn running without it.
 */
import type { InboundEvent } from "../bridge.ts";
import type { ArticleFiles } from "../office/article.ts";
import type { OfficeApi } from "../office/client.ts";

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
  readonly runEnded: (chatThreadKey: string, runId: string) => Promise<void>;
}

const isAside = (text: string) => /^\s*aside\b/i.test(text);

export function slackArticleAccess(options: {
  readonly api: Pick<OfficeApi, "mutate">;
  /** The Office channel's files, read on each call; undefined until Office is set up. */
  readonly articles: () => ArticleFiles | undefined;
  /** The conversation's binding, if any: a follow-up in an unmuted bound thread is a turn too. */
  readonly binding: (chatThreadKey: string) => { readonly muted?: boolean | undefined } | undefined;
  /** The person's Slack profile email, which Office matches when the Slack ID isn't linked. */
  readonly email?: ((userId: string) => Promise<string | undefined>) | undefined;
  readonly log: (line: string) => void;
}): SlackArticleHooks {
  const { api, log } = options;
  // Office runs staged for an event, then for the T3 run it joined. In memory: after a restart,
  // Office ends a lapsed run itself when its token expires.
  const byEvent = new Map<string, { chatId: string; runId: string }>();
  const byRun = new Map<string, Array<{ chatId: string; runId: string }>>();

  const reachesAgent = (event: InboundEvent) => {
    if (event.contextOnly === true || event.forAnotherBot === true || isAside(event.text))
      return false;
    if (event.addressed) return true;
    const binding = options.binding(event.chatThreadKey);
    return binding !== undefined && binding.muted !== true;
  };

  return {
    prepare: async (event) => {
      const articles = options.articles();
      if (articles === undefined || !reachesAgent(event)) return event;
      // Office still matches by Slack ID when the email can't be read. The email is never logged.
      const slackUserEmail = await options.email?.(event.author.userId).catch(() => undefined);
      try {
        const grant = await api.mutate("slackArticleAccess", {
          chatThreadKey: event.chatThreadKey,
          slackUserId: event.author.userId,
          messageTs: event.messageId,
          text: event.text,
          slackUserName: event.author.fullName || event.author.userName,
          ...(slackUserEmail ? { slackUserEmail } : {}),
        });
        if (grant === null) return event;
        const { chatId, ...article } = grant;
        const note = await articles.stage(chatId, event.eventId, article);
        byEvent.set(event.eventId, { chatId, runId: grant.runId });
        return {
          ...event,
          requestNote: [event.requestNote, note].filter(Boolean).join("\n\n"),
        };
      } catch {
        log("Slack: Office article access failed; the turn runs without it.");
        return event;
      }
    },
    dispatched: async (eventId, runId) => {
      const staged = byEvent.get(eventId);
      if (staged === undefined) return;
      await options.articles()?.dispatched(eventId, runId);
      byEvent.delete(eventId);
      byRun.set(runId, [...(byRun.get(runId) ?? []), staged]);
    },
    runEnded: async (_chatThreadKey, runId) => {
      const staged = byRun.get(runId);
      if (staged === undefined) return;
      byRun.delete(runId);
      const chats = new Map<string, Array<string>>();
      for (const each of staged) {
        const runIds = chats.get(each.chatId) ?? [];
        if (!runIds.includes(each.runId)) runIds.push(each.runId);
        chats.set(each.chatId, runIds);
      }
      for (const [chatId, runIds] of chats) {
        await options.articles()?.complete(chatId, runId);
        await api.mutate("slackArticleAccessEnded", { chatId, runIds }).catch(() => {
          log("Slack: couldn't tell Office an article run ended; its access lapses on its own.");
        });
      }
    },
  };
}
