/** Plain-text previews of a chat's final reply for completion notifications. */

/** macOS shows about two lines of body text, so longer replies are cut. */
export const NOTIFICATION_SNIPPET_MAX_LENGTH = 180;

/**
 * Markdown reduced to one readable line: code fences, links, emphasis, and
 * list or heading markers are removed, and whitespace collapses. Returns null
 * when nothing readable is left.
 */
export function formatNotificationSnippet(
  text: string,
  maxLength = NOTIFICATION_SNIPPET_MAX_LENGTH,
): string | null {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|\*|_|~~|`)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length === 0) return null;
  if (plain.length <= maxLength) return plain;
  const cut = plain.slice(0, maxLength - 1);
  const wordEnd = cut.lastIndexOf(" ");
  return `${(wordEnd > maxLength * 0.6 ? cut.slice(0, wordEnd) : cut).trimEnd()}…`;
}

/** The last assistant message's text among loaded messages, oldest first. */
export function lastAssistantText(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.text.trim().length > 0) return message.text;
  }
  return null;
}
