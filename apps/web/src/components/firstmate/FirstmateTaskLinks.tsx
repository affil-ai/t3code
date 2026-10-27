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

import { canOpenLinksInApp } from "~/browser/browserLinkTarget";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { useOpenLink } from "~/browser/useOpenLink";
import {
  resolveExternalWebLinkHref,
  showExternalLinkContextMenu,
} from "~/components/chat/externalLinkContextMenu";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "~/localApi";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { usePullRequestPreviewTarget } from "~/lib/openPullRequestLink";
import { linkedPullRequestDetailAtom } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { SlackIcon } from "../Icons";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";
import { isPullRequestUrl, isSlackUrl } from "@t3tools/client-runtime/firstmate/board";
import { mergedPullRequestLabel } from "@t3tools/client-runtime/firstmate/tasks";
import { CoordinatorThreadContext } from "./firstmateTasksShared";

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

/**
 * Click and right-click behavior for a link in the Tasks panel, the same as a
 * link in chat: a click follows the "Open links in" setting (a modified click
 * goes to the system browser), and the context menu offers the integrated
 * browser, the system browser, and copying the link. Null when the URL is not
 * a web link the panel can open.
 */
export function useTaskLinkHandlers(environmentId: EnvironmentId, url: string) {
  const coordinatorThreadId = use(CoordinatorThreadContext);
  const threadRef =
    coordinatorThreadId === null ? undefined : scopeThreadRef(environmentId, coordinatorThreadId);
  const openLink = useOpenLink(threadRef);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const href = resolveExternalWebLinkHref(url);
  if (href === null) return null;

  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.stopPropagation();
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    void openLink(href, {
      event: {
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        button: event.button,
      },
      threadRef,
    }).catch((cause: unknown) => {
      console.error("Unable to open task link", cause);
    });
  };

  const onContextMenu = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readLocalApi();
    if (!api) return;
    void showExternalLinkContextMenu({
      href,
      canOpenInPreview: canOpenLinksInApp(threadRef),
      position: { x: event.clientX, y: event.clientY },
      showContextMenu: (items, position) => api.contextMenu.show(items, position),
      openInPreview: async (target) => {
        if (!threadRef) throw new Error("Integrated browser is unavailable.");
        const result = await openUrlInPreview({ threadRef, url: target, openPreview });
        if (result._tag === "Failure") throw result.cause;
      },
      openExternal: (target) => api.shell.openExternal(target),
      copyLink: (target) => writeTextToClipboard(target, "link"),
      reportFailure: (operation, cause) => {
        console.error(`Unable to ${operation} for task link`, cause);
      },
    });
  };

  return { href, onClick, onContextMenu };
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
  const handlers = useTaskLinkHandlers(environmentId, link.url);
  const isPullRequest = isPullRequestUrl(link.url);
  const pullRequestTarget = usePullRequestPreviewTarget(environmentId, link.url);
  const pullRequestSummary = useEnvironmentQuery(
    pullRequestTarget === null ? null : linkedPullRequestDetailAtom(pullRequestTarget),
  ).data;
  if (handlers === null) return null;
  if (isPullRequest && pullRequestSummary?.state === "closed") return null;
  const { href, onClick: handleClick, onContextMenu: handleContextMenu } = handlers;
  const label =
    isPullRequest && pullRequestSummary?.state === "merged"
      ? mergedPullRequestLabel(link.label)
      : link.label;

  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {isPullRequestUrl(link.url) ? (
        <PullRequestLinkIcon environmentId={environmentId} url={link.url} />
      ) : isSlackUrl(link.url) ? (
        <SlackIcon className="size-3 shrink-0" />
      ) : (
        <LinkIcon className="size-3 shrink-0" />
      )}
      <span className="truncate">{label}</span>
    </a>
  );
}

export const CARD_LINK_CLASS =
  "inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-sm px-1 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
