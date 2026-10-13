/**
 * The Firstmate page: the task board on the left and the coordinator chat on
 * the right. Narrow windows show one of the two at a time. Until a
 * coordinator is chosen, the page offers to start one or to adopt a chat.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, FirstmateTask, ProjectId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { EllipsisIcon, MessageSquareTextIcon, ShipWheelIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useProjects, useThreadShell, useThreadShells } from "~/state/entities";
import { firstmateEnvironment, useFirstmateSnapshot } from "~/state/firstmate";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import ChatView, { type ChatViewEmbedding } from "../ChatView";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { FirstmateBoard } from "./FirstmateBoard";
import { countFirstmateNeedsYou, recentFirstmateChats } from "./firstmateBoard.logic";

const PAGE_CLASS = "h-dvh min-h-0 overflow-hidden overscroll-y-none";

function PageHeader({ children }: { readonly children?: React.ReactNode }) {
  return (
    <WorkspacePageHeader electron={isElectron} reserveNativeControls={false}>
      <WorkspaceBreadcrumb ariaLabel="Firstmate" className="min-w-0 flex-1">
        <WorkspaceBreadcrumbItem current>
          <h1 className="truncate">Firstmate</h1>
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {children}
    </WorkspacePageHeader>
  );
}

function useFirstmateCommandRunner() {
  const [pending, setPending] = useState<"start" | "setCoordinator" | null>(null);
  const start = useAtomCommand(firstmateEnvironment.start, { reportFailure: false });
  const setCoordinator = useAtomCommand(firstmateEnvironment.setCoordinator, {
    reportFailure: false,
  });
  const run = useCallback(
    async (
      kind: "start" | "setCoordinator",
      execute: () => ReturnType<typeof start> | ReturnType<typeof setCoordinator>,
      failureTitle: string,
    ): Promise<boolean> => {
      setPending(kind);
      const result = await execute();
      setPending(null);
      if (result._tag === "Success") return true;
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: failureTitle,
            description: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      }
      return false;
    },
    [],
  );
  return { pending, start, setCoordinator, run };
}

/** The two ways to give Firstmate a chat, shared by the empty state and the change dialog. */
function CoordinatorSetup({
  environmentId,
  excludeThreadId,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly excludeThreadId?: ThreadId;
  readonly onDone?: () => void;
}) {
  const allProjects = useProjects();
  const projects = useMemo(
    () => allProjects.filter((project) => project.environmentId === environmentId),
    [allProjects, environmentId],
  );
  const allThreads = useThreadShells();
  const chats = useMemo(
    () =>
      recentFirstmateChats(
        allThreads.filter(
          (thread) => thread.environmentId === environmentId && thread.id !== excludeThreadId,
        ),
      ),
    [allThreads, environmentId, excludeThreadId],
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [threadId, setThreadId] = useState<ThreadId | null>(null);
  const selectedProjectId = projectId ?? projects[0]?.id ?? null;
  const selectedThreadId = threadId ?? chats[0]?.id ?? null;
  const canOperate = useAtomValue(firstmateEnvironment.start.permissionAtom(environmentId));
  const { pending, start, setCoordinator, run } = useFirstmateCommandRunner();
  const busy = pending !== null;

  const startFirstmate = async () => {
    if (selectedProjectId === null) return;
    const ok = await run(
      "start",
      () => start({ environmentId, input: { projectId: selectedProjectId } }),
      "Could not start Firstmate",
    );
    if (ok) onDone?.();
  };
  const useChat = async () => {
    if (selectedThreadId === null) return;
    const ok = await run(
      "setCoordinator",
      () => setCoordinator({ environmentId, input: { threadId: selectedThreadId } }),
      "Could not use that chat",
    );
    if (ok) onDone?.();
  };

  return (
    <div className="grid w-full gap-3 text-left sm:grid-cols-2">
      <section className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-xs/5">
        <div className="space-y-0.5">
          <h2 className="text-sm font-medium">Start Firstmate</h2>
          <p className="text-xs text-muted-foreground">Opens a new chat in a project.</p>
        </div>
        <Select
          value={selectedProjectId ?? ""}
          disabled={busy || projects.length === 0 || !canOperate}
          onValueChange={(value) => {
            if (value) setProjectId(value as ProjectId);
          }}
        >
          <SelectTrigger size="sm" aria-label="Project">
            <SelectValue placeholder="No projects">
              {projects.find((project) => project.id === selectedProjectId)?.title}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="sm"
          className="mt-auto"
          disabled={busy || selectedProjectId === null || !canOperate}
          onClick={() => void startFirstmate()}
        >
          {pending === "start" ? <Spinner className="size-3.5" /> : null}
          Start Firstmate
        </Button>
      </section>
      <section className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-xs/5">
        <div className="space-y-0.5">
          <h2 className="text-sm font-medium">Use an existing chat</h2>
          <p className="text-xs text-muted-foreground">Keeps its history and adds the board.</p>
        </div>
        <Select
          value={selectedThreadId ?? ""}
          disabled={busy || chats.length === 0 || !canOperate}
          onValueChange={(value) => {
            if (value) setThreadId(value as ThreadId);
          }}
        >
          <SelectTrigger size="sm" aria-label="Chat">
            <SelectValue placeholder="No recent chats">
              {chats.find((chat) => chat.id === selectedThreadId)?.title}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {chats.map((chat) => (
              <SelectItem key={chat.id} value={chat.id}>
                <span className="flex min-w-0 items-center gap-3">
                  <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTimeLabel(chat.latestUserMessageAt ?? chat.updatedAt)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="sm"
          variant="outline"
          className="mt-auto"
          disabled={busy || selectedThreadId === null || !canOperate}
          onClick={() => void useChat()}
        >
          {pending === "setCoordinator" ? <Spinner className="size-3.5" /> : null}
          Use this chat
        </Button>
      </section>
      {!canOperate ? (
        <p className="text-xs text-muted-foreground sm:col-span-2">
          This connection can view Firstmate but not set it up.
        </p>
      ) : null}
    </div>
  );
}

function FirstmateSetupPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  return (
    <SidebarInset className={PAGE_CLASS}>
      <PageHeader />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Empty className="min-h-full">
          <EmptyHeader className="max-w-xl">
            <EmptyMedia variant="icon">
              <ShipWheelIcon />
            </EmptyMedia>
            <EmptyTitle>Firstmate</EmptyTitle>
            <EmptyDescription>
              One chat for all your requests. It tracks each one as a task and starts a worker for
              it.
            </EmptyDescription>
          </EmptyHeader>
          <div className="w-full max-w-xl">
            <CoordinatorSetup environmentId={environmentId} />
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}

/** A quiet menu for changing or clearing the coordinator chat. */
function CoordinatorMenu({
  environmentId,
  coordinatorThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
}) {
  const [changeOpen, setChangeOpen] = useState(false);
  const canOperate = useAtomValue(
    firstmateEnvironment.setCoordinator.permissionAtom(environmentId),
  );
  const { pending, setCoordinator, run } = useFirstmateCommandRunner();
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost-muted"
              className="shrink-0"
              aria-label="Firstmate options"
              disabled={pending !== null}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: coordinatorThreadId }}
              />
            }
          >
            <MessageSquareTextIcon />
            Open chat on its own
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!canOperate} onClick={() => setChangeOpen(true)}>
            Change chat…
          </MenuItem>
          <MenuItem
            disabled={!canOperate}
            onClick={() =>
              void run(
                "setCoordinator",
                () => setCoordinator({ environmentId, input: { threadId: null } }),
                "Could not stop Firstmate",
              )
            }
          >
            Stop using this chat
          </MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={changeOpen} onOpenChange={setChangeOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Change Firstmate chat</DialogTitle>
            <DialogDescription>Tasks stay as they are. Only the chat changes.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {changeOpen ? (
              <CoordinatorSetup
                environmentId={environmentId}
                excludeThreadId={coordinatorThreadId}
                onDone={() => setChangeOpen(false)}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function CoordinatorChat({
  environmentId,
  coordinatorThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, coordinatorThreadId),
    [coordinatorThreadId, environmentId],
  );
  const threadShell = useThreadShell(threadRef);
  const bootstrapComplete =
    useEnvironmentQuery(environmentShell.stateAtom(environmentId)).data?.snapshot._tag === "Some";
  // The chat stays on the coordinator; links to other chats open as pages.
  const noop = useCallback(() => {}, []);
  const embedding = useMemo<ChatViewEmbedding>(
    () => ({ hostThreadRef: threadRef, onThreadCreated: noop, onOpenThread: noop }),
    [noop, threadRef],
  );
  if (threadShell === null && bootstrapComplete) {
    return (
      <Empty size="compact" className="min-h-0">
        <EmptyHeader>
          <EmptyTitle>This chat is gone</EmptyTitle>
          <EmptyDescription>
            It was deleted or archived. Pick another chat from the menu above the board.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ChatView
      key={`${environmentId}:${coordinatorThreadId}`}
      environmentId={environmentId}
      threadId={coordinatorThreadId}
      routeKind="server"
      reserveTitleBarControlInset={false}
      embedded={embedding}
    />
  );
}

type NarrowPane = "board" | "chat";

function FirstmateWorkspace({
  environmentId,
  coordinatorThreadId,
  tasks,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
  readonly tasks: readonly FirstmateTask[];
}) {
  const narrow = useMediaQuery("max-lg");
  const [pane, setPane] = useState<NarrowPane>("board");
  const needsYou = countFirstmateNeedsYou(tasks);
  const showBoard = !narrow || pane === "board";
  const showChat = !narrow || pane === "chat";
  return (
    <SidebarInset className={PAGE_CLASS}>
      <div className="flex min-h-0 min-w-0 flex-1">
        {showBoard ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
            <PageHeader>
              {narrow ? <PaneToggle pane={pane} needsYou={needsYou} onChange={setPane} /> : null}
              <CoordinatorMenu
                environmentId={environmentId}
                coordinatorThreadId={coordinatorThreadId}
              />
            </PageHeader>
            <FirstmateBoard environmentId={environmentId} tasks={tasks} />
          </div>
        ) : null}
        {showChat ? (
          <div
            className={
              narrow
                ? "flex min-h-0 min-w-0 flex-1 flex-col"
                : "flex min-h-0 w-[clamp(22rem,38%,34rem)] shrink-0 flex-col border-s border-border/70"
            }
          >
            {narrow ? (
              <PageHeader>
                <PaneToggle pane={pane} needsYou={needsYou} onChange={setPane} />
              </PageHeader>
            ) : null}
            <div className="relative flex min-h-0 flex-1 flex-col">
              <CoordinatorChat
                environmentId={environmentId}
                coordinatorThreadId={coordinatorThreadId}
              />
            </div>
          </div>
        ) : null}
      </div>
    </SidebarInset>
  );
}

function PaneToggle({
  pane,
  needsYou,
  onChange,
}: {
  readonly pane: NarrowPane;
  readonly needsYou: number;
  readonly onChange: (pane: NarrowPane) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Show"
      className="shrink-0"
      value={[pane]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "board" || value === "chat") onChange(value);
      }}
    >
      <Toggle value="board">
        Board
        {needsYou > 0 ? (
          <span className="ms-1 text-2xs font-semibold tabular-nums text-warning-foreground">
            {needsYou}
          </span>
        ) : null}
      </Toggle>
      <Toggle value="chat">Chat</Toggle>
    </ToggleGroup>
  );
}

function CenteredStatus({ children }: { readonly children: React.ReactNode }) {
  return (
    <SidebarInset className={PAGE_CLASS}>
      <PageHeader />
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        {children}
      </div>
    </SidebarInset>
  );
}

export function FirstmatePage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const snapshotQuery = useFirstmateSnapshot(environmentId);
  const snapshot = snapshotQuery.data;
  if (snapshot === null) {
    return snapshotQuery.error ? (
      <CenteredStatus>
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>Firstmate isn't available</EmptyTitle>
            <EmptyDescription>
              This server doesn't run Firstmate, or it couldn't be reached.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CenteredStatus>
    ) : (
      <CenteredStatus>
        <Spinner className="size-4" />
        Loading Firstmate…
      </CenteredStatus>
    );
  }
  if (snapshot.coordinatorThreadId === null) {
    return <FirstmateSetupPage environmentId={environmentId} />;
  }
  return (
    <FirstmateWorkspace
      environmentId={environmentId}
      coordinatorThreadId={snapshot.coordinatorThreadId}
      tasks={snapshot.tasks}
    />
  );
}
