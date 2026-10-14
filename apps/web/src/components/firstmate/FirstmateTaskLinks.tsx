/**
 * The links on a task: its worker chat, and each external link with an icon
 * for what it points at. A pull request link shows its live state, drawn like
 * the sidebar's.
 *
 * @module FirstmateTaskLinks
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FirstmateTask } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { LinkIcon, MessageSquareTextIcon } from "lucide-react";
import { type MouseEvent, use } from "react";

import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { usePullRequestPreviewTarget } from "~/lib/openPullRequestLink";
import { linkedPullRequestDetailAtom } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { SlackIcon } from "../Icons";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { isPullRequestUrl, isSlackUrl } from "./firstmateBoard.logic";
import { CoordinatorThreadContext } from "./firstmateTasksShared";

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
  const coordinatorThreadId = use(CoordinatorThreadContext);
  if (task.workerThreadId === null) return null;
  const workerThreadId = task.workerThreadId;
  // Beside the coordinator's chat, the worker opens as a chat tab in the right
  // panel so the coordinator stays in place. A modified click still follows the link.
  const openBeside = (event: MouseEvent) => {
    event.stopPropagation();
    if (coordinatorThreadId === null) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
      return;
    event.preventDefault();
    useRightPanelStore
      .getState()
      .openChat(scopeThreadRef(environmentId, coordinatorThreadId), workerThreadId);
  };
  return (
    <Link
      className={className}
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: workerThreadId }}
      onClick={openBeside}
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
