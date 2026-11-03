/**
 * Readable text from a raw Slack message. Apps often put the real body in
 * Block Kit or legacy attachments and leave only a summary in `text`, and a
 * link's label can hide its URL. This adds those parts to the text the Chat
 * SDK gives, the way Office does.
 */
import { SlackFormatConverter } from "@chat-adapter/slack";

interface Link {
  readonly url: string;
  readonly label?: string | undefined;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const converter = new SlackFormatConverter();
const toPlainText = (text: string) => converter.extractPlainText(text);

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Letters and digits only, so the same words in different markup compare equal. */
const comparable = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function contains(existing: string, candidate: string): boolean {
  const inner = comparable(candidate);
  return inner !== "" && comparable(existing).includes(inner);
}

function pushString(record: UnknownRecord, key: string, output: Array<string>): void {
  const text = record[key];
  if (typeof text === "string" && text.trim()) output.push(text);
}

function pushTextValue(value: unknown, output: Array<string>): void {
  if (typeof value === "string") output.push(value);
  else if (isRecord(value)) pushString(value, "text", output);
}

function pushTextElement(value: unknown, output: Array<string>): void {
  if (!isRecord(value)) return;
  pushString(value, "text", output);
  for (const element of list(value.elements)) pushTextElement(element, output);
}

/** Text in blocks, skipping button rows, whose links are read separately. */
function pushBlocks(value: unknown, output: Array<string>): void {
  for (const block of list(value)) {
    if (!isRecord(block) || block.type === "actions" || block.type === "context_actions") continue;
    pushTextValue(block.text, output);
    for (const field of list(block.fields)) pushTextValue(field, output);
    for (const element of list(block.elements)) pushTextElement(element, output);
  }
}

/** Block and attachment text, as plain text, without repeats. */
function readableParts(raw: UnknownRecord): Array<string> {
  const fragments: Array<string> = [];
  pushBlocks(raw.blocks, fragments);
  for (const attachment of list(raw.attachments)) {
    if (!isRecord(attachment)) continue;
    // Slack's fallback is often the most complete; keeping it first lets the fragments it contains go.
    for (const key of ["fallback", "pretext", "title", "text"])
      pushString(attachment, key, fragments);
    for (const field of list(attachment.fields)) {
      if (!isRecord(field)) continue;
      pushString(field, "title", fragments);
      pushString(field, "value", fragments);
    }
    pushBlocks(attachment.blocks, fragments);
  }
  const output: Array<string> = [];
  const seen = new Set<string>();
  for (const fragment of fragments) {
    const text = toPlainText(fragment).trim();
    const key = comparable(text);
    if (!key || seen.has(key) || output.some((existing) => contains(existing, text))) continue;
    seen.add(key);
    output.push(text);
  }
  return output;
}

/** Links in rich text and shared work objects, such as a Google Doc, whose label may hide the URL. */
function richTextLinks(raw: UnknownRecord): Array<Link> {
  const links: Array<Link> = [];
  for (const block of list(raw.blocks)) {
    if (!isRecord(block)) continue;
    for (const section of list(block.elements)) {
      if (!isRecord(section)) continue;
      for (const element of list(section.elements)) {
        if (!isRecord(element) || !isHttpUrl(element.url)) continue;
        const label = typeof element.text === "string" ? element.text.trim() : "";
        if (element.type === "link") {
          links.push({
            url: element.url,
            label: label && label !== element.url ? label : undefined,
          });
        } else if (element.type === "attachment_mention") {
          links.push({ url: element.url, label: label || undefined });
        }
      }
    }
  }
  return links;
}

/** Button links, such as "Open PR". */
function actionLinks(raw: UnknownRecord): Array<Link> {
  const links: Array<Link> = [];
  const blocks = [
    ...list(raw.blocks),
    ...list(raw.attachments).flatMap((attachment) =>
      isRecord(attachment) ? list(attachment.blocks) : [],
    ),
  ];
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== "actions") continue;
    for (const element of list(block.elements)) {
      if (!isRecord(element) || !isHttpUrl(element.url)) continue;
      const text = element.text;
      const label =
        typeof text === "string"
          ? text
          : isRecord(text) && typeof text.text === "string"
            ? text.text
            : "";
      links.push({ url: element.url, label: label.trim() || undefined });
    }
  }
  return links;
}

/** `<https://…|label>` links in Slack markup, whose plain text keeps only the label. */
function markupLinks(raw: UnknownRecord): Array<Link> {
  const fragments: Array<string> = [];
  pushString(raw, "text", fragments);
  pushBlocks(raw.blocks, fragments);
  for (const attachment of list(raw.attachments)) {
    if (!isRecord(attachment)) continue;
    for (const key of ["fallback", "pretext", "text"]) pushString(attachment, key, fragments);
    for (const field of list(attachment.fields)) {
      if (isRecord(field)) pushString(field, "value", fragments);
    }
    pushBlocks(attachment.blocks, fragments);
  }
  return fragments.flatMap((fragment) =>
    [...fragment.matchAll(/<(https?:\/\/[^>|]+)(?:\|([^>]+))?>/g)].flatMap((match) => {
      const url = match[1]
        ?.replaceAll("&amp;", "&")
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">");
      if (!isHttpUrl(url)) return [];
      return [{ url, label: match[2]?.trim() || undefined }];
    }),
  );
}

/**
 * `text` with the message's block and attachment text added below it, then
 * each link whose URL the reader would not otherwise see, as `label: url`.
 */
export function withRichContent(text: string, raw: unknown): string {
  if (!isRecord(raw)) return text;
  const parts = readableParts(raw).filter((part) => !contains(text, part));
  const readable = [text, ...parts].join("\n");
  const links = new Map<string, Link>();
  for (const link of [...richTextLinks(raw), ...actionLinks(raw), ...markupLinks(raw)]) {
    if (!links.has(link.url) && !readable.includes(link.url)) links.set(link.url, link);
  }
  if (parts.length === 0 && links.size === 0) return text;
  return [
    text.trim(),
    ...parts,
    ...[...links.values()].map(({ url, label }) => `${label || "Link"}: ${url}`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** The footer apps such as ChatGPT add to a message they post for someone: `Sent using @ChatGPT`. */
const ATTRIBUTION =
  /[ \t]*\*?Sent using\*?[ \t]+(?:<@[UW][A-Z0-9]+(?:\|[^>]*)?>|@[\w.-]+)[ \t]*$/gim;

/**
 * Removes that footer. Its mention of the posting app is not a request to
 * that app, and the agent would otherwise copy the footer into its replies.
 */
export function withoutAttribution(text: string): string {
  return text
    .replace(ATTRIBUTION, "")
    .replace(/\n{2,}$/, "")
    .trim();
}
