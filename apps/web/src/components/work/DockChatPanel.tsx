/**
 * A chat shown in the right panel ("dock") beside the main thread.
 *
 * With a thread it mounts the main area's ChatView in embedded mode, so the
 * dock has the same timeline and composer as the main chat. The embedded view
 * answers window-level shortcuts only for events from inside it and never
 * navigates. Until the surface has a thread, the panel offers a new chat in
 * the project and lists related chats: the main chat's lineage first, then the
 * other chats in its repository. Each row shows the chat's provider logo.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  EnvironmentId,
  type ModelSelection,
  type ScopedThreadRef,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { MessageSquarePlusIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
import { useArchivedThreadSnapshots } from "~/lib/archivedThreadsState";
import { newThreadId } from "~/lib/utils";
import { type ChatSurface, useRightPanelStore } from "~/rightPanelStore";
import { useThreadProjection, useThreadShell, useThreadShells } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { resolveThreadWorkProjectId, useWorkModeStore } from "~/workModeStore";
import { ThreadRelationshipIcon } from "../chat/ThreadRelationshipIcon";
import ChatView, { type ChatViewEmbedding } from "../ChatView";
import { type DockChatSection, sectionDockChatCandidates } from "./DockChatPanel.logic";

export interface DockChatDefaults {
  /** The host thread's model, used for a new chat when its project sets no default. */
  modelSelection: ModelSelection;
}

function useDockChatSections(
  project: EnvironmentProject,
  hostThreadRef: ScopedThreadRef,
): DockChatSection[] {
  const threads = useThreadShells();
  const hostProjection = useThreadProjection(hostThreadRef)?.projection ?? null;
  const archivedEnvironmentIds = useMemo(
    () => [hostThreadRef.environmentId],
    [hostThreadRef.environmentId],
  );
  const archived = useArchivedThreadSnapshots(archivedEnvironmentIds);
  const archivedThreads = useMemo(
    () =>
      archived.snapshots
        .filter((entry) => entry.environmentId === hostThreadRef.environmentId)
        .flatMap((entry) =>
          entry.snapshot.threads.map((thread) => presentThreadShell(entry.environmentId, thread)),
        ),
    [archived.snapshots, hostThreadRef.environmentId],
  );
  const candidateThreads = useMemo(() => {
    const byKey = new Map(
      threads.map(
        (thread) =>
          [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
      ),
    );
    for (const thread of archivedThreads) {
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (!byKey.has(key)) byKey.set(key, thread);
    }
    return [...byKey.values()];
  }, [archivedThreads, threads]);
  const lineageThreadKeys = useMemo(() => {
    const graph = deriveThreadRelationshipGraph({
      threads: [
        ...threads
          .filter((thread) => thread.environmentId === hostThreadRef.environmentId)
          .map((thread) => thread.source),
        ...archivedThreads.map((thread) => thread.source),
      ],
      projection: hostProjection,
    });
    return new Set(
      immediateThreadRelationships(graph, hostThreadRef.threadId).map((row) =>
        scopedThreadKey(scopeThreadRef(hostThreadRef.environmentId, row.threadId)),
      ),
    );
  }, [archivedThreads, hostProjection, hostThreadRef, threads]);
  return useMemo(
    () =>
      sectionDockChatCandidates({
        threads: candidateThreads,
        hostThreadRef,
        hostProjectId: project.id,
        repoTitle: project.title,
        lineageThreadKeys,
      }),
    [candidateThreads, hostThreadRef, lineageThreadKeys, project.id, project.title],
  );
}

export function DockChatPanel(props: {
  hostThreadRef: ScopedThreadRef;
  surface: ChatSurface;
  project: EnvironmentProject;
  defaults: DockChatDefaults;
}) {
  const { hostThreadRef, surface, project } = props;
  const environmentId = project.environmentId;
  const fallbackModelSelection = props.defaults.modelSelection;
  const sections = useDockChatSections(project, hostThreadRef);
  // Surfaces persisted before new chats reserved an id get one for this mount.
  const [fallbackDraftThreadId] = useState(newThreadId);
  // A new chat keys its composer draft by the reserved id, and its first
  // message creates the thread under that id.
  const draftThreadId = ThreadId.make(surface.draftThreadId ?? fallbackDraftThreadId);
  // A new chat the user already started writing reopens as that chat.
  const [newChatOpen, setNewChatOpen] = useState(() =>
    composerDraftHasUserContent(
      useComposerDraftStore
        .getState()
        .getComposerDraft(scopeThreadRef(environmentId, draftThreadId)),
    ),
  );
  // The thread this panel's new chat created. It stays a new chat until the
  // thread's detail arrives, so the view never drops its first message.
  const [createdThreadId, setCreatedThreadId] = useState<string | null>(null);
  // Only a chat the user just opened takes focus, not one restored on mount.
  const [autoFocus, setAutoFocus] = useState(false);

  const threadId =
    surface.threadId !== null
      ? ThreadId.make(surface.threadId)
      : newChatOpen
        ? draftThreadId
        : null;
  // An existing chat can live in another environment; a new chat starts in the project's.
  const chatEnvironmentId =
    surface.threadId !== null && surface.environmentId
      ? EnvironmentId.make(surface.environmentId)
      : environmentId;
  const threadRef = useMemo(
    () => (threadId === null ? null : scopeThreadRef(chatEnvironmentId, threadId)),
    [chatEnvironmentId, threadId],
  );
  const threadShell = useThreadShell(threadRef);
  // A new chat's thread does not exist yet; wait for its shell before syncing it.
  const syncThreadRef = threadShell === null ? null : threadRef;
  const threadDetail = useThreadProjection(syncThreadRef);
  const bootstrapComplete =
    useEnvironmentQuery(environmentShell.stateAtom(chatEnvironmentId)).data?.snapshot._tag ===
    "Some";
  const isNewChat =
    threadId !== null &&
    threadDetail === null &&
    (surface.threadId === null || surface.threadId === createdThreadId);
  const selectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      setAutoFocus(true);
      useRightPanelStore
        .getState()
        .setChatSurfaceThread(hostThreadRef, surface.id, thread.id, thread.environmentId);
    },
    [hostThreadRef, surface.id],
  );
  const startNewChat = useCallback(() => {
    setAutoFocus(true);
    setNewChatOpen(true);
  }, []);
  const onThreadCreated = useCallback(
    (createdId: ThreadId) => {
      // A chat started beside a thread is filed in the host's Work project, if it has one.
      const workState = useWorkModeStore.getState();
      const workProjectId = resolveThreadWorkProjectId(workState, scopedThreadKey(hostThreadRef));
      if (workProjectId !== null) {
        workState.fileThreads(
          [scopedThreadKey(scopeThreadRef(environmentId, createdId))],
          workProjectId,
        );
      }
      setCreatedThreadId(createdId);
      useRightPanelStore.getState().setChatSurfaceThread(hostThreadRef, surface.id, createdId);
    },
    [environmentId, hostThreadRef, surface.id],
  );
  const onOpenThread = useCallback(
    (openedId: ThreadId) => {
      useRightPanelStore
        .getState()
        .setChatSurfaceThread(hostThreadRef, surface.id, openedId, chatEnvironmentId);
    },
    [chatEnvironmentId, hostThreadRef, surface.id],
  );
  // A new chat starts in the host chat's workspace, so it keeps working in the
  // same worktree unless the user picks a new one.
  const hostThreadShell = useThreadShell(hostThreadRef);
  const hostBranch = hostThreadShell?.branch ?? null;
  const hostWorktreePath = hostThreadShell?.worktreePath ?? null;
  const embedding = useMemo<ChatViewEmbedding>(
    () => ({
      hostThreadRef,
      ...(isNewChat
        ? {
            newThread: {
              projectId: project.id,
              fallbackModelSelection,
              workspace: { branch: hostBranch, worktreePath: hostWorktreePath },
            },
          }
        : {}),
      onThreadCreated,
      onOpenThread,
      autoFocus,
    }),
    [
      autoFocus,
      fallbackModelSelection,
      hostBranch,
      hostThreadRef,
      hostWorktreePath,
      isNewChat,
      onOpenThread,
      onThreadCreated,
      project.id,
    ],
  );

  // A chat whose thread is gone once the environment has loaded goes back to the list.
  const threadMissing = !isNewChat && threadShell === null && bootstrapComplete;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-dock-chat>
      {threadId === null || threadMissing ? (
        <DockChatPicker
          sections={sections}
          projectTitle={project.title}
          onNewChat={startNewChat}
          onSelect={selectThread}
        />
      ) : (
        <ChatView
          key={`${chatEnvironmentId}:${threadId}`}
          environmentId={chatEnvironmentId}
          threadId={threadId}
          routeKind="server"
          embedded={embedding}
        />
      )}
    </div>
  );
}

function DockChatPicker(props: {
  sections: ReadonlyArray<DockChatSection>;
  projectTitle: string;
  onNewChat: () => void;
  onSelect: (thread: EnvironmentThreadShell) => void;
}) {
  const { sections, projectTitle, onNewChat, onSelect } = props;
  const providersByEnvironment = useEnvironmentProviders();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-3">
      <button
        type="button"
        className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-accent/60"
        onClick={onNewChat}
      >
        <MessageSquarePlusIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">New chat</span>
        <span className="min-w-0 max-w-[45%] shrink truncate text-xs font-normal text-muted-foreground">
          {projectTitle}
        </span>
      </button>
      {sections.map((section) => (
        <section key={section.id}>
          <p className="mt-3 mb-1 truncate px-2 text-xs font-medium text-muted-foreground">
            {section.title}
          </p>
          <div className="flex flex-col gap-0.5">
            {section.threads.map((thread) => (
              <button
                key={`${thread.environmentId}:${thread.id}`}
                type="button"
                className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent/60"
                onClick={() => onSelect(thread)}
              >
                <DockChatThreadIcon
                  thread={thread}
                  providers={providersByEnvironment.get(thread.environmentId)}
                />
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** The chat's current provider logo with its run status dot, as lineage rows show it. */
function DockChatThreadIcon(props: {
  thread: EnvironmentThreadShell;
  providers: ReadonlyArray<ServerProvider> | undefined;
}) {
  const { thread, providers } = props;
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const provider = providers?.find((entry) => entry.instanceId === instanceId);
  return (
    <ThreadRelationshipIcon
      driver={provider?.driver}
      provider={provider}
      status={thread.runtime?.status ?? thread.latestRun?.status ?? null}
    />
  );
}
