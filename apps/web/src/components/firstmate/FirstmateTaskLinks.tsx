/**
 * The links on a task: its worker chat, and each external link with an icon
 * for what it points at. A pull request link shows its live state, drawn like
 * the sidebar's.
 *
 * @module FirstmateTaskLinks
 */
import type { EnvironmentId, FirstmateTask } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { LinkIcon, MessageSquareTextIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { usePullRequestPreviewTarget } from "~/lib/openPullRequestLink";
import { linkedPullRequestDetailAtom } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { SlackIcon } from "../Icons";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { isPullRequestUrl, isSlackUrl } from "./firstmateBoard.logic";

function stopPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export function WorkerThreadLink({
  environmentId,
  task,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
  readonly className?: string;
}) {
  if (task.workerThreadId === null) return null;
  return (
    <Link
      className={className}
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: task.workerThreadId }}
      onClick={stopPropagation}
    >
      <MessageSquareTextIcon className="size-3 shrink-0" />
      <span className="truncate">Chat</span>
    </Link>
  );
}

/**
 * A pull request link's icon, drawn like the sidebar's: the state's glyph in
 * its color (open, draft, merged, closed). Until the state loads, or when no
 * project here can read the repository, it is the plain open glyph.
 */
function PullRequestLinkIcon({
  environmentId,
  url,
}: {
  readonly environmentId: EnvironmentId;
  readonly url: string;
}) {
  const target = usePullRequestPreviewTarget(environmentId, url);
  const summary = useEnvironmentQuery(
    target === null ? null : linkedPullRequestDetailAtom(target),
  ).data;
  if (!summary) return <PullRequestGlyph.pullRequest className="size-3 shrink-0" />;
  const state = resolvePullRequestState({
    state: summary.state,
    isDraft: summary.isDraft === true,
  });
  return (
    <state.Icon
      data-tone
      className={cn("size-3 shrink-0", state.toneClassName)}
      aria-label={`Pull request ${state.label.toLowerCase()}`}
    />
  );
}

export function ExternalTaskLink({
  environmentId,
  link,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly link: FirstmateTask["links"][number];
  readonly className?: string;
}) {
  return (
    <a
      className={className}
      href={link.url}
      target="_blank"
      rel="noreferrer"
      onClick={stopPropagation}
    >
      {isPullRequestUrl(link.url) ? (
        <PullRequestLinkIcon environmentId={environmentId} url={link.url} />
      ) : isSlackUrl(link.url) ? (
        <SlackIcon className="size-3 shrink-0" />
      ) : (
        <LinkIcon className="size-3 shrink-0" />
      )}
      <span className="truncate">{link.label}</span>
    </a>
  );
}

export const CARD_LINK_CLASS =
  "inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
