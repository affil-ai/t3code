/**
 * How a reply that reaches a Slack thread reads. Keyed on where the turn's replies land,
 * not where it entered: an Office or Linear turn in a chat synced with a Slack thread posts
 * there too, through `chat_post` and the idle fallback.
 */

/**
 * The Slack style rule. People skim a thread on a phone, so it gives numbers to keep to,
 * and a place for the detail that doesn't fit.
 */
export const SLACK_REPLY_STYLE = [
  "Write for Slack, where people skim on a phone.",
  "Put the answer in the first line.",
  "Keep each message to at most 5 short lines or bullets and about 80 words, with no headings, tables or long code blocks.",
  "Leave out commit SHAs, run or deployment IDs, file paths, test counts and tool narration unless the reader needs them to act; give a link instead of an ID.",
  "When more detail matters, put it where it can be read in full (the PR, a file you post, or the Office chat when you have its link) and link to it in one line instead of writing it out.",
].join(" ");

/** Told to a turn that entered elsewhere when its replies also go to a Slack thread. */
const LINKED_SLACK =
  "This chat is linked to a Slack thread: what you send with chat_post appears there too, and your final message can be posted there as well, so write both for Slack.";

const isSlack = (chatThreadKey: string) => chatThreadKey.startsWith("slack:");

/**
 * What one turn is told about Slack, or undefined when nothing it says reaches Slack.
 * `destinations` are every conversation the turn's posts and answer go to, the one it
 * entered through included. A Slack thread's first turn gets nothing here: its first-turn
 * note carries `SLACK_REPLY_STYLE` with the rest of how Slack works.
 */
export function slackReplyNote(turn: {
  readonly enteredThrough: string;
  readonly first: boolean;
  readonly destinations: ReadonlyArray<string>;
}): string | undefined {
  if (isSlack(turn.enteredThrough)) return turn.first ? undefined : SLACK_REPLY_STYLE;
  if (!turn.destinations.some(isSlack)) return undefined;
  return `${LINKED_SLACK} ${SLACK_REPLY_STYLE}`;
}
