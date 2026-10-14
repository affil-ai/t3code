// fork: pr-watch-quiet
import type {
  OrchestrationV2Notification,
  PullRequestComment,
  ThreadPullRequestWatch,
} from "@t3tools/contracts";

/**
 * How long a watched pull request stays green and unchanged before watching stops. Review
 * bots post within about 12 minutes of checks passing, so this leaves them room to finish.
 */
export const PULL_REQUEST_WATCH_QUIET_MS = 15 * 60_000;

/**
 * When a remark last changed. A bot's plain comment counts only when it is posted: deploy
 * bots such as Vercel rewrite one status comment on every deploy, which is not news.
 */
export const remarkActiveAt = (remark: PullRequestComment) =>
  remark.author?.isBot === true && remark.kind === "issue-comment"
    ? remark.createdAt
    : (remark.editedAt ?? remark.createdAt);

/**
 * The watch has reported its checks passed, the branch does not conflict, and nothing has
 * changed for the quiet period, so the pull request only waits on the user.
 */
export const isPullRequestWatchQuiet = (watch: ThreadPullRequestWatch, now: number) =>
  watch.passed &&
  !watch.conflicting &&
  watch.changedAt !== undefined &&
  now - Date.parse(watch.changedAt) >= PULL_REQUEST_WATCH_QUIET_MS;

/** The wake that tells the agent watching ended because the pull request went quiet. */
export const pullRequestWatchQuietMessage = (input: {
  readonly number: number;
  readonly url: string;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } => ({
  text: `Pull request #${input.number} (${input.url}) has passed its checks with no new comments, pushes, or conflicts for ${PULL_REQUEST_WATCH_QUIET_MS / 60_000} minutes, so T3 Code stopped watching it. If your work on it is done, hand it back to the user. Call watch_pull_request to watch it again.`,
  notification: {
    source: { kind: "monitor" },
    outcome: "completed",
    summary: `#${input.number}: quiet, stopped watching`,
  },
});
