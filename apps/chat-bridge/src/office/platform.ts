// @effect-diagnostics globalFetch:off globalTimers:off -- A plain Node channel; Convex owns its subscription.
import { type Bridge, type InboundEvent } from "../bridge.ts";
import { mimeTypeOf } from "../fileMimeType.ts";
import type { ModelSelection } from "../modelCommand.ts";
import { type ChatPlatform, QUIET_RULES, RetryAfter, type ThreadRoute } from "../platform.ts";
import type { BridgeStore, ConversationSeed } from "../store.ts";
import { ArticleFiles } from "./article.ts";
import type { InboxEvent, OfficeApi, PreparedRequest } from "./client.ts";
import {
  historyNote,
  officeChatUrl,
  officeModel,
  requestNote,
  slackThreadOf,
  threadStartConventions,
} from "./message.ts";

const chatIdOf = (key: string) => key.slice("office:".length);

function inbound(request: PreparedRequest): InboundEvent {
  return {
    eventId: `office:${request.eventId}`,
    chatThreadKey: `office:${request.chatId}`,
    channelId: request.chatId,
    messageId: request.messageId,
    kind: "mention",
    direct: true,
    addressed: true,
    author: {
      userId: request.author.memberId,
      userName: request.author.name,
      fullName: request.author.name,
    },
    text: request.text,
    files: [],
    mentions: [],
  };
}

export function createOfficeChannel(options: {
  api: OfficeApi;
  store: BridgeStore;
  route: ThreadRoute;
  home: string;
  repositoryPath: string;
  log: (line: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  slack?: ChatPlatform | undefined;
}) {
  const { api, store, log } = options;
  /**
   * The chat's model. Office's selection is followed: a later change switches the
   * thread. A model key without one only picks the model a new thread starts on.
   * With neither, the thread runs on the bridge's default.
   */
  const chatModel = (request: PreparedRequest) => {
    if (request.modelSelection !== undefined)
      return { modelSelection: request.modelSelection, followModel: true };
    const modelSelection = officeModel(request.model);
    if (modelSelection === undefined) {
      log(
        request.model === undefined
          ? `Office: chat ${request.chatId} has no recorded model; it runs on the default.`
          : `Office: chat ${request.chatId} has model ${JSON.stringify(request.model)}, which has no stock T3 model; it runs on the default.`,
      );
      return {};
    }
    return { modelSelection };
  };
  const fetchFile = options.fetch ?? fetch;
  const articles = new ArticleFiles(options.home, options.repositoryPath, log, options.now);
  const pending = new Map<string, Promise<void>>();
  const chats = new Map<string, Promise<void>>();
  const retries = new Map<string, NodeJS.Timeout>();
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  let core: Bridge;

  const state: NonNullable<ChatPlatform["setState"]> = async (key, value, text, outcome) => {
    await api.mutate("state", {
      chatId: chatIdOf(key),
      state: value,
      text,
      // Office finishes the requests it handed over with this outcome, and keeps the rest queued.
      ...(value === "active" && outcome !== undefined ? { outcome } : {}),
    });
  };
  const platform: ChatPlatform = {
    id: "office",
    name: "Office",
    place: "Office chat",
    access: { allowEveryone: true, allowedUserIds: [] },
    directRoute: options.route,
    person: (_id, name) => name,
    refusal: () => "You no longer have access to this Office chat.",
    acknowledgeFirst: true,
    firstTurnNote: (chatKey) =>
      [
        "Your final message is posted to this Office chat. Use chat_post for files or updates, and chat_status for short progress text. Reactions are unavailable.",
        QUIET_RULES,
        threadStartConventions(),
        `Chat key: ${chatKey}`,
      ].join("\n\n"),
    prepare: async (event) => {
      const eventId = event.eventId.slice("office:".length);
      const result = await api.mutate("prepare", { eventId });
      if (result.kind === "later") {
        await api.mutate("requestCompaction", { chatId: chatIdOf(event.chatThreadKey) });
        throw new RetryAfter(result.retryAfterMs);
      }
      if (result.kind === "skip") {
        await api.mutate("ack", {
          eventId,
          result: "rejected",
          errorMessage: "This request is no longer available or authorized.",
        });
        return undefined;
      }
      const request = result.request;
      if (request.slack && !(await linkSlack(eventId, request))) return undefined;
      const seed = store.seed(event.chatThreadKey);
      // Only the safe inbound event reaches SQLite; this context lives for this handoff.
      const articleNote =
        request.article === undefined
          ? ""
          : await articles.stage(request.chatId, event.eventId, request.article);
      return {
        ...inbound(request),
        requestNote: [requestNote(request), articleNote].filter(Boolean).join("\n\n"),
        instructions: request.instructions,
        ...chatModel(request),
        historyNote:
          request.history || seed
            ? historyNote(
                {
                  ...(request.history ?? { recent: [] }),
                  ...(seed && !request.history?.oldThreadId
                    ? { oldThreadId: seed.oldThreadId }
                    : {}),
                },
                // A chat with a summary, or one imported from the old server, carries on from before.
                seed || request.history?.summary
                  ? {
                      chatUrl: request.chatUrl,
                      slackThread: slackThreadOf(
                        request.slack?.chatThreadKey,
                        ...store.seeds(request.chatId).map((each) => each.chatThreadKey),
                      ),
                    }
                  : undefined,
              )
            : undefined,
        files: request.files.map((file) => ({
          name: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.byteSize,
          url: file.url,
        })),
      };
    },
    dispatched: async (eventId, runId) => {
      await articles.dispatched(eventId, runId);
      await api.mutate("ack", { eventId: eventId.slice("office:".length), result: "stored" });
    },
    runEnded: (key, runId) => articles.complete(chatIdOf(key), runId),
    post: async (message) => {
      if (!message.eventId) throw new Error("Office posts require a delivery identity.");
      const chatId = chatIdOf(message.chatThreadKey);
      const files: Array<{ storageId: string; filename: string; mimeType: string }> = [];
      for (const file of message.files ?? []) {
        const mimeType = mimeTypeOf(file.filename);
        const { url } = await api.mutate("uploadUrl", { chatId });
        const response = await fetchFile(url, {
          method: "POST",
          headers: { "content-type": mimeType },
          body: new Uint8Array(file.data),
        }).catch(() => {
          throw new Error("Office file upload failed.");
        });
        if (!response.ok) throw new Error(`Office file upload failed: HTTP ${response.status}.`);
        const uploaded = (await response.json()) as { storageId?: string };
        if (typeof uploaded.storageId !== "string")
          throw new Error("Office upload returned no storage id.");
        files.push({ storageId: uploaded.storageId, filename: file.filename, mimeType });
      }
      await api.mutate("post", {
        chatId,
        eventId: message.eventId,
        kind: message.kind ?? "answer",
        text: message.text,
        ...(files.length === 0 ? {} : { files }),
      });
    },
    // No `quiet`: the run's end sets `active` with the turn's outcome right after.
    setState: state,
    step: async (key, step) => {
      await api.mutate("step", {
        chatId: chatIdOf(key),
        itemId: step.itemId,
        action: step.action.slice(0, 500),
        parameter: step.parameter.slice(0, 500),
        result: step.result.slice(0, 500),
      });
    },
    plan: async (key, steps) => {
      await api.mutate("plan", {
        chatId: chatIdOf(key),
        steps: steps.map((step) => ({
          text: step.text,
          status: step.status === "running" ? "inProgress" : step.status,
        })),
      });
    },
    rename: async (key, title) => {
      await api.mutate("rename", { chatId: chatIdOf(key), title });
    },
    download: async (url) => {
      const response = await fetchFile(url).catch(() => {
        throw new Error("Office file download failed.");
      });
      if (!response.ok) throw new Error(`Office file download failed: HTTP ${response.status}.`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };

  async function deliver(event: InboxEvent): Promise<void> {
    const eventId = `office:${event.id}`;
    if (!store.isHandled(eventId)) {
      if (event.kind === "stop") {
        const chatThreadKey = `office:${event.chatId}`;
        const stopped = await core.stopRequested(chatThreadKey, event.memberId);
        if (!stopped && store.binding(chatThreadKey) !== undefined) {
          throw new Error("Office stop could not reach T3.");
        }
        store.markHandled(eventId);
        if (!core.hasRunInFlight(chatThreadKey))
          await state(chatThreadKey, "active", "", "canceled");
      } else {
        const outcome = await core.receive({
          eventId,
          chatThreadKey: `office:${event.chatId}`,
          channelId: event.chatId,
          messageId: event.messageId,
          kind: "mention",
          direct: true,
          addressed: true,
          author: { userId: "", userName: "", fullName: "" },
          text: "",
          files: [],
          mentions: [],
        });
        if (outcome.type === "ignored" && outcome.reason === "not_allowed") return;
        // A pending event belongs to the durable bridge inbox now, including its retry deadline.
        // Office retains it until prepare is ready so firstTurn/history remain available.
        if (
          outcome.type === "pending" ||
          (outcome.type === "ignored" &&
            outcome.reason === "duplicate" &&
            !store.isHandled(eventId))
        )
          return;
      }
    }
    await api.mutate("ack", { eventId: event.id, result: "stored" });
  }

  async function linkSlack(eventId: string, request: PreparedRequest): Promise<boolean> {
    const slack = options.slack;
    if (slack?.startConversation === undefined || request.slack === undefined) {
      await api.mutate("ack", {
        eventId,
        result: "rejected",
        errorMessage:
          "The Slack channel is not configured on this bridge. This request was not sent.",
      });
      return false;
    }
    const target = request.slack;
    const savedKey = store.meta(`office_slack:${eventId}`);
    const chatThreadKey =
      target.chatThreadKey ??
      savedKey ??
      (await slack.startConversation(target.channelId, target.rootText ?? request.text));
    if (!target.chatThreadKey) {
      store.setMeta(`office_slack:${eventId}`, chatThreadKey);
      await api.mutate("linkSlack", { eventId, chatThreadKey });
    }
    await core.linkConversations(
      [
        {
          chatThreadKey: `office:${request.chatId}`,
          channelId: request.chatId,
          createdByUserId: request.author.memberId,
        },
        { chatThreadKey, channelId: target.channelId, createdByUserId: request.author.memberId },
      ],
      request.sync ?? false,
    );
    return true;
  }

  function enqueue(event: InboxEvent): void {
    if (closed || pending.has(event.id) || retries.has(event.id)) return;
    const chatId = event.chatId;
    const previous = chats.get(chatId) ?? Promise.resolve();
    const task = previous
      .then(() => deliver(event))
      .catch(() => {
        if (closed) return;
        log(`Office: delivery ${event.id} failed; retrying in 15 s.`);
        const timer = setTimeout(() => {
          retries.delete(event.id);
          enqueue(event);
        }, 15_000);
        timer.unref();
        retries.set(event.id, timer);
      })
      .finally(() => {
        pending.delete(event.id);
        if (chats.get(chatId) === task) chats.delete(chatId);
      });
    pending.set(event.id, task);
    chats.set(chatId, task);
  }

  const idle = async () => {
    await Promise.all(pending.values());
  };
  return {
    platform,
    /** Shared with Slack turns that get Office article access, so one place owns these files. */
    articles,
    /** The model of an Office chat a Slack conversation continues; undefined when it has none. */
    async chatModel(chatId: string): Promise<ModelSelection | undefined> {
      return (await api.chatModel(chatId)) ?? undefined;
    },
    async seedHistory(seed: ConversationSeed): Promise<string> {
      const result = await api.history(seed.chatId);
      if (result.kind === "later") {
        await api.mutate("requestCompaction", { chatId: seed.chatId });
        throw new RetryAfter(result.retryAfterMs);
      }
      return historyNote(
        {
          ...result.history,
          oldThreadId: result.history.oldThreadId ?? seed.oldThreadId,
        },
        {
          chatUrl: officeChatUrl(seed.chatId),
          slackThread: slackThreadOf(
            seed.chatThreadKey,
            ...store.seeds(seed.chatId).map((each) => each.chatThreadKey),
          ),
        },
      );
    },
    async start(bridge: Bridge): Promise<void> {
      core = bridge;
      await articles.restore();
      unsubscribe = api.subscribe(
        (events) => {
          for (const event of events) enqueue(event);
        },
        () => log("Office: inbox subscription failed; waiting for Convex to reconnect."),
      );
    },
    idle,
    async close(): Promise<void> {
      closed = true;
      unsubscribe?.();
      for (const timer of retries.values()) clearTimeout(timer);
      await idle();
      await articles.close();
      await api.close();
    },
  };
}
