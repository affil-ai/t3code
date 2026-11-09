import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import type { SlackInboxRow, SlackRelaySource } from "../slack/relay.ts";

export type InboxEvent =
  | { id: string; kind: "message"; chatId: string; messageId: string; createdAt: number }
  | { id: string; kind: "stop"; chatId: string; memberId: string; createdAt: number };

export interface OfficeHistory {
  summary?: string;
  recent: Array<{ role: "user" | "assistant"; author?: string; text: string; at: number }>;
  oldThreadId?: string;
}

export type HistoryResult =
  | { kind: "ready"; history: OfficeHistory }
  | { kind: "later"; retryAfterMs: number };

export interface PreparedRequest {
  eventId: string;
  chatId: string;
  chatUrl: string;
  messageId: string;
  author: { memberId: string; name: string; email: string };
  text: string;
  files: Array<{
    attachmentId: string;
    filename: string;
    mimeType: string;
    byteSize: number;
    url: string;
  }>;
  modeKey: string;
  model?: string;
  /** The chat's own model. It wins over `model` and the bridge's default, and a follow-up switches the thread to it. */
  modelSelection?: {
    instanceId: string;
    model: string;
    options?: Array<{ id: string; value: string | boolean }>;
  };
  instructions: string;
  firstTurn: boolean;
  history?: OfficeHistory;
  slack?: { channelId: string; chatThreadKey?: string; rootText?: string };
  sync?: boolean;
  article?: {
    convexUrl: string;
    token: string;
    runId: string;
    expiresAt: number;
    targetId?: string;
    snapshot?: unknown;
    instructions: string;
  };
}

export type Prepared =
  | { kind: "ready"; request: PreparedRequest }
  | { kind: "later"; retryAfterMs: number }
  | { kind: "skip"; reason: string };

export interface OfficeMutations {
  requestCompaction: { args: { chatId: string }; result: unknown };
  prepare: { args: { eventId: string }; result: Prepared };
  ack: {
    args: { eventId: string; result: "stored" | "rejected"; errorMessage?: string };
    result: unknown;
  };
  post: {
    args: {
      chatId: string;
      eventId: string;
      kind: "answer" | "question" | "update";
      text: string;
      files?: Array<{ storageId: string; filename: string; mimeType: string }>;
    };
    result: unknown;
  };
  uploadUrl: { args: { chatId: string }; result: { url: string } };
  step: {
    args: { chatId: string; itemId: string; action: string; parameter: string; result: string };
    result: unknown;
  };
  plan: {
    args: {
      chatId: string;
      steps: Array<{ text: string; status: "pending" | "inProgress" | "completed" }>;
    };
    result: unknown;
  };
  state: {
    args: {
      chatId: string;
      state: "processing" | "suspended" | "active";
      text: string;
      /** Only with `active`: how the turn ended. */
      outcome?: "completed" | "failed" | "canceled";
    };
    result: unknown;
  };
  rename: { args: { chatId: string; title: string }; result: unknown };
  linkSlack: { args: { eventId: string; chatThreadKey: string }; result: unknown };
}

export interface OfficeApi {
  history(chatId: string): Promise<HistoryResult>;
  subscribe(onInbox: (events: InboxEvent[]) => void, onError: () => void): () => void;
  mutate<K extends keyof OfficeMutations>(
    name: K,
    args: OfficeMutations[K]["args"],
  ): Promise<OfficeMutations[K]["result"]>;
  close(): Promise<void>;
}

/** Convex owns subscription reconnects. Neither its logger nor thrown errors may expose arguments. */
export class OfficeClient implements OfficeApi, SlackRelaySource {
  private readonly client: ConvexClient;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.token = token;
    this.client = new ConvexClient(url, { logger: false });
  }

  subscribe(onInbox: (events: InboxEvent[]) => void, onError: () => void): () => void {
    return this.client.onUpdate(
      makeFunctionReference<"query", { serviceToken: string }, { events: InboxEvent[] }>(
        "chatBridge:inbox",
      ),
      { serviceToken: this.token },
      (result) => onInbox(result.events),
      () => onError(),
    );
  }

  /** Slack requests Office verified and stored for the bridge, oldest first. */
  subscribeSlackInbox(
    onRows: (rows: ReadonlyArray<SlackInboxRow>) => void,
    onError: () => void,
  ): () => void {
    return this.client.onUpdate(
      makeFunctionReference<
        "query",
        { serviceToken: string; limit?: number },
        Array<SlackInboxRow>
      >("chatBridge:slackInbox"),
      { serviceToken: this.token },
      (rows) => onRows(rows),
      () => onError(),
    );
  }

  async slackDelivered(ids: ReadonlyArray<string>): Promise<void> {
    try {
      await this.client.mutation(
        makeFunctionReference<"mutation", { serviceToken: string; ids: Array<string> }, unknown>(
          "chatBridge:slackDelivered",
        ),
        { serviceToken: this.token, ids: [...ids] },
      );
    } catch {
      throw new Error("Office slackDelivered failed.");
    }
  }

  async history(chatId: string): Promise<HistoryResult> {
    try {
      return await this.client.query(
        makeFunctionReference<"query", { serviceToken: string; chatId: string }, HistoryResult>(
          "chatBridge:history",
        ),
        { serviceToken: this.token, chatId },
      );
    } catch {
      throw new Error("Office history failed.");
    }
  }

  async mutate<K extends keyof OfficeMutations>(
    name: K,
    args: OfficeMutations[K]["args"],
  ): Promise<OfficeMutations[K]["result"]> {
    try {
      return await this.client.mutation(
        makeFunctionReference<
          "mutation",
          Record<string, import("convex/values").Value>,
          OfficeMutations[K]["result"]
        >(`chatBridge:${name}`),
        { ...args, serviceToken: this.token },
      );
    } catch {
      throw new Error(`Office ${name} failed.`);
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
