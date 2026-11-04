// @effect-diagnostics globalDate:off -- A plain Node app; it does not use Effect.
/**
 * A Chat SDK adapter for iMessage over `imsg` on a Mac (via `mac/affil-imessage`).
 * Thread ids are `imessage:<chat rowid>`; every message counts as addressed.
 * Without SIP off, `imsg` can't edit, unsend, send tapbacks, type or mark read.
 */
import { extractFiles, toBuffer, ValidationError } from "@chat-adapter/shared";
import {
  type Adapter,
  getEmoji,
  type AdapterPostableMessage,
  type Attachment,
  BaseFormatConverter,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  Message,
  paragraph,
  type RawMessage,
  type Root,
  root,
  stringifyMarkdown,
  text as textNode,
  type ThreadInfo,
} from "chat";

import { ImsgRpc, type Notification } from "./rpc.ts";

/** A message as `imsg` returns it; see imsg's docs/json.md. */
export interface ImsgMessage {
  readonly id: number;
  readonly chat_id: number;
  readonly guid: string;
  readonly sender?: string;
  readonly sender_name?: string;
  readonly is_from_me: boolean;
  readonly text?: string;
  readonly created_at?: string;
  readonly is_group?: boolean;
  readonly type?: "edited" | "unsent";
  readonly is_reaction?: boolean;
  /** `love`, `like`, `dislike`, `laugh`, `emphasis`, `question`, or a custom emoji marker. */
  readonly reaction_type?: string;
  readonly reaction_emoji?: string;
  readonly is_reaction_add?: boolean;
  /** The tapped message's guid, sometimes with a `p:0/` part prefix. */
  readonly reacted_to_guid?: string;
  readonly attachments?: ReadonlyArray<{
    readonly transfer_name?: string;
    readonly filename?: string;
    readonly mime_type?: string;
    readonly total_bytes?: number;
    readonly missing?: boolean;
    readonly original_path?: string;
  }>;
}

interface ImsgChat {
  readonly id: number;
  readonly name?: string;
  readonly service?: string;
  readonly is_group?: boolean;
  readonly participants?: ReadonlyArray<string>;
}

export interface ImessageAdapterConfig {
  /** Where `affil-imessage` listens; usually an SSH tunnel to the Mac. */
  readonly host: string;
  readonly port: number;
  /** Chats on these services are read; others, such as SMS, are left alone. */
  readonly services: ReadonlyArray<string>;
  /** On the very first start, read messages after this row id. Without it, only new ones. */
  readonly startAfterRowId?: number | undefined;
  /**
   * Send tapbacks through imsg's private Messages bridge. It needs SIP off on
   * the Mac and `imsg launch`; tapbacks stay off until `status` shows it running.
   */
  readonly outboundReactions?: boolean | undefined;
  readonly log: (line: string) => void;
}

/** iMessage's six standard tapbacks, as Chat SDK emoji names. */
const TAPBACK_EMOJI: Readonly<Record<string, string>> = {
  love: "heart",
  like: "thumbs_up",
  dislike: "thumbs_down",
  laugh: "laugh",
  emphasis: "exclamation",
  question: "question",
};

/** Emoji names an agent or the SDK may use, to the standard tapback each sends. */
const TAPBACK_KIND: Readonly<Record<string, string>> = {
  heart: "love",
  love: "love",
  red_heart: "love",
  thumbs_up: "like",
  thumbsup: "like",
  "+1": "like",
  like: "like",
  thumbs_down: "dislike",
  thumbsdown: "dislike",
  "-1": "dislike",
  dislike: "dislike",
  laugh: "laugh",
  joy: "laugh",
  laughing: "laugh",
  haha: "laugh",
  exclamation: "emphasis",
  bangbang: "emphasis",
  emphasis: "emphasis",
  question: "question",
};

/** The tapback a reaction asks for, or nothing when iMessage has no standard one. */
export function tapbackKind(emoji: string): string | undefined {
  return TAPBACK_KIND[emoji.replace(/^:|:$/g, "").toLowerCase()];
}

/** The guid a tapback points at, without its `p:N/` part prefix. */
export const reactedGuid = (target: string) => target.replace(/^[a-z]*:\d+\//, "");

const CURSOR_KEY = "imessage:cursor";
const JPEG_MARK = "#jpeg";
const CATCH_UP_PAGE = 100;

/** iMessage shows plain text: Markdown is flattened, keeping link targets and list markers. */
export class ImessageFormatConverter extends BaseFormatConverter {
  toAst(platformText: string): Root {
    return root([paragraph([textNode(platformText)])]);
  }

  fromAst(ast: Root): string {
    return stringifyMarkdown(ast)
      .replace(/^```[^\n]*\n?/gm, "")
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
      .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1")
      .replace(/!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_all, label: string, url: string) =>
        label === "" || label === url ? url : `${label} (${url})`,
      )
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^(\s*)[-*+] /gm, "$1• ")
      .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1")
      .trim();
  }
}

export class ImessageAdapter implements Adapter<number, ImsgMessage> {
  readonly name = "imessage";
  readonly userName = "t3";
  private chat: ChatInstance | undefined;
  private readonly rpc: ImsgRpc;
  private readonly converter = new ImessageFormatConverter();
  private readonly chats = new Map<number, ImsgChat>();
  /** Incoming messages are handled one at a time, in order, on this chain. */
  private queue: Promise<void> = Promise.resolve();
  /** Whether imsg's private bridge can send tapbacks now; checked on each connect. */
  private tapbacks = false;

  private readonly config: ImessageAdapterConfig;

  constructor(config: ImessageAdapterConfig) {
    this.config = config;
    this.rpc = new ImsgRpc({
      host: config.host,
      port: config.port,
      onNotification: (notification) => this.notified(notification),
      onConnect: () =>
        this.enqueue(async () => {
          await this.checkTapbacks();
          await this.catchUp();
        }),
      log: config.log,
    });
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.rpc.start();
  }

  async disconnect(): Promise<void> {
    this.rpc.close();
  }

  /** True when outbound tapbacks are on in config and imsg's private bridge is running. */
  get canReact(): boolean {
    return this.tapbacks;
  }

  private async checkTapbacks(): Promise<void> {
    if (this.config.outboundReactions !== true) return;
    try {
      const status = await this.rpc.call<{
        methods?: ReadonlyArray<string>;
        bridge?: { ready?: boolean; error?: string };
      }>("status");
      const ready = status.bridge?.ready === true && (status.methods ?? []).includes("tapback");
      if (ready !== this.tapbacks || !ready) {
        this.config.log(
          ready
            ? "iMessage: tapbacks are on (imsg's private bridge is running)."
            : `iMessage: tapbacks are off; imsg's private bridge isn't running${status.bridge?.error ? ` (${status.bridge.error})` : ""}.`,
        );
      }
      this.tapbacks = ready;
    } catch (error) {
      this.tapbacks = false;
      this.config.log(`iMessage: checking for tapbacks failed: ${String(error)}`);
    }
  }

  // Thread ids

  encodeThreadId(chatId: number): string {
    return `imessage:${chatId}`;
  }

  decodeThreadId(threadId: string): number {
    const [prefix, id, ...rest] = threadId.split(":");
    const chatId = Number(id);
    if (prefix !== "imessage" || rest.length > 0 || !Number.isInteger(chatId) || chatId <= 0) {
      throw new ValidationError("imessage", `Not an iMessage thread id: ${threadId}`);
    }
    return chatId;
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(threadId: string): boolean {
    return this.chats.get(this.decodeThreadId(threadId))?.is_group !== true;
  }

  async handleWebhook(): Promise<Response> {
    return new Response("iMessage has no webhooks.", { status: 404 });
  }

  // Incoming

  parseMessage(raw: ImsgMessage): Message<ImsgMessage> {
    const sender = raw.sender ?? "";
    const text = raw.text ?? "";
    return new Message<ImsgMessage>({
      // The guid, which tapbacks name their target by.
      id: raw.guid,
      threadId: this.encodeThreadId(raw.chat_id),
      text,
      formatted: this.converter.toAst(text),
      raw,
      author: {
        userId: sender,
        userName: sender,
        fullName: raw.sender_name || sender,
        isBot: false,
        isMe: raw.is_from_me,
      },
      metadata: {
        dateSent: raw.created_at ? new Date(raw.created_at) : new Date(0),
        edited: raw.type === "edited",
      },
      attachments: (raw.attachments ?? [])
        .filter((each) => each.missing !== true && each.original_path)
        .map((each) => this.attachment(each)),
      isMention: true,
    });
  }

  private attachment(file: NonNullable<ImsgMessage["attachments"]>[number]): Attachment {
    const name = file.transfer_name || file.filename || "attachment";
    // iPhone photos are HEIC, which models don't read; the Mac hands them over as JPEG.
    const heic = /^image\/hei[cf]/.test(file.mime_type ?? "") || /\.hei[cf]$/i.test(name);
    const mimeType = heic ? "image/jpeg" : (file.mime_type ?? "application/octet-stream");
    const kind = mimeType.split("/")[0];
    // `download` gets the Mac path, with a `#jpeg` mark when the Mac converts it.
    const url = `${file.original_path!}${heic ? JPEG_MARK : ""}`;
    return {
      type: kind === "image" || kind === "video" || kind === "audio" ? kind : "file",
      name: heic ? name.replace(/\.hei[cf]$/i, "") + ".jpg" : name,
      mimeType,
      ...(file.total_bytes === undefined || heic ? {} : { size: file.total_bytes }),
      url,
      fetchData: () => this.readAttachment(url),
    };
  }

  /** Reads a file under the Mac's Messages attachments folder, by the `url` its attachment has. */
  async readAttachment(url: string): Promise<Buffer> {
    const jpeg = url.endsWith(JPEG_MARK);
    const path = jpeg ? url.slice(0, -JPEG_MARK.length) : url;
    const result = await this.rpc.call<{ data: string }>("attachment.read", {
      path,
      ...(jpeg ? { jpeg: true } : {}),
    });
    return Buffer.from(result.data, "base64");
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((error: unknown) => {
      this.config.log(`iMessage: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private notified(notification: Notification): void {
    if (notification.method !== "message") return;
    const raw = notification.params.message as ImsgMessage | undefined;
    if (raw === undefined) return;
    this.enqueue(() => this.receive(raw));
  }

  /** What arrived while the bridge or the tunnel was down, from the saved row id on. */
  private async catchUp(): Promise<void> {
    const state = this.chat!.getState();
    let cursor = (await state.get<number>(CURSOR_KEY)) ?? this.config.startAfterRowId;
    if (cursor === undefined) return;
    let read = 0;
    for (;;) {
      const page = await this.rpc.call<{
        messages: Array<ImsgMessage>;
        next_rowid: number;
        has_more: boolean;
      }>("messages.after", {
        since_rowid: cursor,
        limit: CATCH_UP_PAGE,
        attachments: true,
        include_reactions: true,
      });
      for (const raw of page.messages) await this.receive(raw);
      read += page.messages.length;
      cursor = Math.max(cursor, page.next_rowid);
      await state.set(CURSOR_KEY, cursor);
      if (!page.has_more) break;
    }
    if (read > 0) this.config.log(`iMessage: caught up on ${read} messages.`);
  }

  private async chatInfo(chatId: number): Promise<ImsgChat> {
    const known = this.chats.get(chatId);
    if (known !== undefined) return known;
    const info = await this.rpc.call<ImsgChat>("chats.get", { chat_id: chatId });
    this.chats.set(chatId, info);
    return info;
  }

  /** Hands one new message or tapback to the SDK, then moves the cursor past it. */
  private async receive(raw: ImsgMessage): Promise<void> {
    const state = this.chat!.getState();
    // Edits and unsends reuse older rows; only new rows count.
    const isNew = raw.type === undefined;
    const wanted =
      isNew &&
      !raw.is_from_me &&
      (raw.is_reaction === true
        ? raw.reacted_to_guid !== undefined
        : Boolean(raw.text?.trim() || raw.attachments?.length));
    if (wanted && this.config.services.includes((await this.chatInfo(raw.chat_id)).service ?? "")) {
      const threadId = this.encodeThreadId(raw.chat_id);
      if (raw.is_reaction === true) await this.reacted(threadId, raw);
      else await this.chat!.processMessage(this, threadId, this.parseMessage(raw));
    }
    if (raw.type === undefined) {
      const cursor = (await state.get<number>(CURSOR_KEY)) ?? 0;
      if (raw.id > cursor) await state.set(CURSOR_KEY, raw.id);
    }
  }

  /** A tapback on a message, as a Chat SDK reaction. */
  private async reacted(threadId: string, raw: ImsgMessage): Promise<void> {
    const standard = raw.reaction_type ? TAPBACK_EMOJI[raw.reaction_type] : undefined;
    const rawEmoji = raw.reaction_emoji || raw.reaction_type || "";
    if (rawEmoji === "") return;
    const sender = raw.sender ?? "";
    await this.chat!.processReaction({
      adapter: this,
      threadId,
      messageId: reactedGuid(raw.reacted_to_guid!),
      emoji: getEmoji(standard ?? rawEmoji),
      rawEmoji,
      added: raw.is_reaction_add !== false,
      user: {
        userId: sender,
        userName: sender,
        fullName: raw.sender_name || sender,
        isBot: false,
        isMe: false,
      },
      raw,
    });
  }

  // Outgoing

  /**
   * Sends once. An "uncertain" answer (imsg's -32001) may have been delivered,
   * so it isn't retried; sending again could post the message twice.
   */
  private async send(params: Record<string, unknown>): Promise<{ id?: number; guid?: string }> {
    try {
      return await this.rpc.call("send", { ...params, allow_sms_fallback: false });
    } catch (error) {
      if ((error as { code?: unknown }).code !== -32001) throw error;
      this.config.log(`iMessage: imsg couldn't confirm a send; not retrying it: ${String(error)}`);
      return {};
    }
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ImsgMessage>> {
    const chatId = this.decodeThreadId(threadId);
    let text = this.converter.renderPostable(message).trim();
    let last: { id?: number; guid?: string } = {};
    // Every file is staged on the Mac first, so a failed upload sends nothing.
    const staged: Array<string> = [];
    for (const file of extractFiles(message)) {
      const data = await toBuffer(file.data, {
        platform: "imessage" as never,
        throwOnUnsupported: false,
      });
      if (data === null) continue;
      const written = await this.rpc.call<{ path: string }>("attachment.write", {
        name: file.filename,
        data: data.toString("base64"),
      });
      staged.push(written.path);
    }
    // The text rides with the first file: one send, and imsg can confirm it by the text.
    for (const path of staged) {
      last = await this.send({ chat_id: chatId, file: path, ...(text ? { text } : {}) });
      text = "";
    }
    if (text !== "") last = await this.send({ chat_id: chatId, text });
    const id = last.guid ?? "";
    return {
      id,
      threadId,
      raw: { id: last.id ?? 0, chat_id: chatId, guid: last.guid ?? "", is_from_me: true },
    };
  }

  async editMessage(): Promise<RawMessage<ImsgMessage>> {
    throw new ValidationError("imessage", "iMessage messages can't be edited from the bridge.");
  }

  async deleteMessage(): Promise<void> {
    throw new ValidationError("imessage", "iMessage messages can't be unsent from the bridge.");
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.tapback(threadId, messageId, emoji, false);
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
  ): Promise<void> {
    await this.tapback(threadId, messageId, emoji, true);
  }

  private async tapback(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string,
    remove: boolean,
  ): Promise<void> {
    if (!this.tapbacks) {
      throw new ValidationError(
        "imessage",
        "iMessage tapbacks are off: they need imsg's private Messages bridge, which needs SIP off on the Mac.",
      );
    }
    const name = typeof emoji === "string" ? emoji : emoji.name;
    const kind = tapbackKind(name);
    if (kind === undefined) {
      throw new ValidationError(
        "imessage",
        `iMessage has no ${name} tapback. Use heart, thumbsup, thumbsdown, laugh, bangbang or question.`,
      );
    }
    await this.rpc.call("tapback", {
      chat_id: this.decodeThreadId(threadId),
      message_guid: messageId,
      kind,
      ...(remove ? { remove: true } : {}),
    });
  }

  /** Typing bubbles need the private Messages bridge; nothing to show without it. */
  async startTyping(): Promise<void> {}

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  // History

  async fetchMessages(threadId: string, options?: FetchOptions): Promise<FetchResult<ImsgMessage>> {
    const chatId = this.decodeThreadId(threadId);
    const result = await this.rpc.call<{ messages: Array<ImsgMessage> }>("messages.history", {
      chat_id: chatId,
      limit: options?.limit ?? 50,
      attachments: true,
    });
    // imsg returns the newest first; row ids give the order.
    const messages = result.messages
      .filter((raw) => raw.is_reaction !== true)
      .toSorted((a, b) => a.id - b.id)
      .map((raw) => this.parseMessage(raw));
    return { messages };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const info = await this.chatInfo(this.decodeThreadId(threadId));
    return {
      id: threadId,
      channelId: threadId,
      ...(info.name ? { channelName: info.name } : {}),
      isDM: info.is_group !== true,
      metadata: { service: info.service, participants: info.participants ?? [] },
    };
  }
}

export function createImessageAdapter(config: ImessageAdapterConfig): ImessageAdapter {
  return new ImessageAdapter(config);
}
