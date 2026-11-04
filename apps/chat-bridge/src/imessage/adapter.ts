// @effect-diagnostics globalDate:off -- A plain Node app; it does not use Effect.
/**
 * A Chat SDK adapter for iMessage over `imsg` on a Mac (via `mac/affil-imessage`).
 * Thread ids are `imessage:<chat rowid>`; every message counts as addressed.
 * Without SIP off, `imsg` can't edit, unsend, react, type or mark read.
 */
import { extractFiles, toBuffer, ValidationError } from "@chat-adapter/shared";
import {
  type Adapter,
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
  readonly log: (line: string) => void;
}

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

  private readonly config: ImessageAdapterConfig;

  constructor(config: ImessageAdapterConfig) {
    this.config = config;
    this.rpc = new ImsgRpc({
      host: config.host,
      port: config.port,
      onNotification: (notification) => this.notified(notification),
      onConnect: () => this.enqueue(() => this.catchUp()),
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
      id: String(raw.id),
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
      }>("messages.after", { since_rowid: cursor, limit: CATCH_UP_PAGE, attachments: true });
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

  /** Hands one new message to the SDK, then moves the cursor past it. */
  private async receive(raw: ImsgMessage): Promise<void> {
    const state = this.chat!.getState();
    // Edits, unsends and tapbacks reuse or point at older rows; only new rows count.
    const isNew = raw.type === undefined && raw.is_reaction !== true;
    if (isNew && !raw.is_from_me && (raw.text?.trim() || raw.attachments?.length)) {
      const info = await this.chatInfo(raw.chat_id);
      if (this.config.services.includes(info.service ?? "")) {
        await this.chat!.processMessage(
          this,
          this.encodeThreadId(raw.chat_id),
          this.parseMessage(raw),
        );
      }
    }
    if (raw.type === undefined) {
      const cursor = (await state.get<number>(CURSOR_KEY)) ?? 0;
      if (raw.id > cursor) await state.set(CURSOR_KEY, raw.id);
    }
  }

  // Outgoing

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<ImsgMessage>> {
    const chatId = this.decodeThreadId(threadId);
    const text = this.converter.renderPostable(message).trim();
    let last: { id?: number; guid?: string } = {};
    if (text !== "") {
      last = await this.rpc.call("send", { chat_id: chatId, text, allow_sms_fallback: false });
    }
    for (const file of extractFiles(message)) {
      const data = await toBuffer(file.data, {
        platform: "imessage" as never,
        throwOnUnsupported: false,
      });
      if (data === null) continue;
      const staged = await this.rpc.call<{ path: string }>("attachment.write", {
        name: file.filename,
        data: data.toString("base64"),
      });
      last = await this.rpc.call("send", {
        chat_id: chatId,
        file: staged.path,
        allow_sms_fallback: false,
      });
    }
    const id = String(last.id ?? last.guid ?? "");
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
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new ValidationError(
      "imessage",
      "Tapbacks need the Mac's private Messages bridge, which is off.",
    );
  }

  async removeReaction(): Promise<void> {
    throw new ValidationError(
      "imessage",
      "Tapbacks need the Mac's private Messages bridge, which is off.",
    );
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
    // imsg returns the newest first.
    const messages = result.messages
      .filter((raw) => raw.is_reaction !== true)
      .map((raw) => this.parseMessage(raw))
      .toSorted((a, b) => Number(a.id) - Number(b.id));
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
