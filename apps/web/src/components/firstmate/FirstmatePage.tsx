/**
 * The Firstmate page: the task board on the left and the coordinator chat on
 * the right. Narrow windows show one of the two at a time. Until a
 * coordinator is set, the page offers one button that starts a fresh one.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, FirstmateTask, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { EllipsisIcon, MessageSquareTextIcon, ShipWheelIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useThreadShell } from "~/state/entities";
import { firstmateEnvironment, useFirstmateSnapshot } from "~/state/firstmate";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatView, { type ChatViewEmbedding } from "../ChatView";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { FirstmateBoard } from "./FirstmateBoard";
import { countFirstmateNeedsYou } from "./firstmateBoard.logic";
import { useFirstmateModelSelection } from "./firstmateModel";

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

function FirstmateSetupPage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const modelSelection = useFirstmateModelSelection(environmentId);
  const canOperate = useAtomValue(firstmateEnvironment.start.permissionAtom(environmentId));
  const { pending, start, run } = useFirstmateCommandRunner();
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
          <Button
            disabled={pending !== null || modelSelection === null || !canOperate}
            onClick={() => {
              if (modelSelection === null) return;
              void run(
                "start",
                () => start({ environmentId, input: { modelSelection } }),
                "Could not start Firstmate",
              );
            }}
          >
            {pending === "start" ? <Spinner className="size-3.5" /> : null}
            Start Firstmate
          </Button>
        </Empty>
      </div>
    </SidebarInset>
  );
}

/** A quiet menu for opening or clearing the coordinator chat. */
function CoordinatorMenu({
  environmentId,
  coordinatorThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId;
}) {
  const canOperate = useAtomValue(
    firstmateEnvironment.setCoordinator.permissionAtom(environmentId),
  );
  const { pending, setCoordinator, run } = useFirstmateCommandRunner();
  return (
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
            It was deleted or archived. Choose Stop using this chat in the menu above the board to
            start a new one.
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
