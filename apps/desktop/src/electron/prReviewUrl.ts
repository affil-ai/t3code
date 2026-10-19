// Fork: GitHub pull requests open in Devin Review, which serves the same paths.
const GITHUB_PULL_REQUEST_PATH = /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/;

export function toPullRequestReviewUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com" || !GITHUB_PULL_REQUEST_PATH.test(parsed.pathname)) {
    return url;
  }
  parsed.hostname = "devinreview.com";
  return parsed.href;
}
