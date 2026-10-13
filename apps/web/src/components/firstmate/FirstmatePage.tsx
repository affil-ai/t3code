/**
 * The Firstmate route. Firstmate itself is the coordinator's normal chat
 * with the Tasks tab in its right panel, so once a coordinator is set this
 * page only forwards to that chat. Until then it offers one button that
 * starts a fresh coordinator.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, FirstmateSnapshot, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { isElectron } from "~/env";
import { useThreadShell } from "~/state/entities";
import { firstmateEnvironment, useFirstmateSnapshot } from "~/state/firstmate";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { openFirstmateTasks, useFirstmateCommands } from "./firstmateCommands";
import { FirstmateIcon } from "./firstmateIcons";
import { useFirstmateModelSelection } from "./firstmateModel";

const PAGE_CLASS = "h-dvh min-h-0 overflow-hidden overscroll-y-none";

function Page({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <SidebarInset className={PAGE_CLASS}>
      <WorkspacePageHeader electron={isElectron} reserveNativeControls={false}>
        <WorkspaceBreadcrumb ariaLabel={title} className="min-w-0 flex-1">
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{title}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </SidebarInset>
  );
}

function CenteredStatus({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function FirstmateSetup({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: FirstmateSnapshot;
}) {
  const navigate = useNavigate();
  const modelSelection = useFirstmateModelSelection(environmentId);
  const canOperate = useAtomValue(firstmateEnvironment.start.permissionAtom(environmentId));
  const { pending, start, run } = useFirstmateCommands();
  return (
    <Empty className="min-h-full">
      <EmptyHeader className="max-w-xl">
        <EmptyMedia variant="icon">
          <FirstmateIcon icon={snapshot.icon} />
        </EmptyMedia>
        <EmptyTitle>{snapshot.name}</EmptyTitle>
        <EmptyDescription>
          One chat for all your requests. It tracks each one as a task and starts a worker for it.
        </EmptyDescription>
      </EmptyHeader>
      <Button
        disabled={pending !== null || modelSelection === null || !canOperate}
        onClick={() => {
          if (modelSelection === null) return;
          void run(
            "start",
            () => start({ environmentId, input: { modelSelection } }),
            `Could not start ${snapshot.name}`,
          ).then((started) => {
            if (started === null) return;
            openFirstmateTasks(environmentId, started.threadId);
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: started.threadId },
              replace: true,
            });
          });
        }}
      >
        {pending === "start" ? <Spinner className="size-3.5" /> : null}
        Start {snapshot.name}
      </Button>
    </Empty>
  );
}

/** The coordinator was deleted or archived; offer to clear it so a new one can start. */
function CoordinatorGone({
  environmentId,
  snapshot,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: FirstmateSnapshot;
}) {
  const canOperate = useAtomValue(
    firstmateEnvironment.setCoordinator.permissionAtom(environmentId),
  );
  const { pending, setCoordinator, run } = useFirstmateCommands();
  return (
    <Empty className="min-h-full">
      <EmptyHeader>
        <EmptyTitle>{snapshot.name}'s chat is gone</EmptyTitle>
        <EmptyDescription>
          It was deleted or archived. Stop using it to start a new one.
        </EmptyDescription>
      </EmptyHeader>
      <Button
        variant="outline"
        disabled={pending !== null || !canOperate}
        onClick={() =>
          void run(
            "setCoordinator",
            () => setCoordinator({ environmentId, input: { threadId: null } }),
            `Could not stop ${snapshot.name}`,
          )
        }
      >
        {pending === "setCoordinator" ? <Spinner className="size-3.5" /> : null}
        Stop using this chat
      </Button>
    </Empty>
  );
}

/** Replaces this route with the coordinator chat and shows its Tasks tab. */
function ForwardToCoordinator({
  environmentId,
  snapshot,
  coordinatorThreadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly snapshot: FirstmateSnapshot;
  readonly coordinatorThreadId: ThreadId;
}) {
  const navigate = useNavigate();
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, coordinatorThreadId),
    [coordinatorThreadId, environmentId],
  );
  const threadShell = useThreadShell(threadRef);
  const bootstrapComplete =
    useEnvironmentQuery(environmentShell.stateAtom(environmentId)).data?.snapshot._tag === "Some";
  const gone = threadShell === null && bootstrapComplete;
  useEffect(() => {
    if (gone) return;
    openFirstmateTasks(environmentId, coordinatorThreadId);
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: coordinatorThreadId },
      replace: true,
    });
  }, [coordinatorThreadId, environmentId, gone, navigate]);
  if (gone) return <CoordinatorGone environmentId={environmentId} snapshot={snapshot} />;
  return (
    <CenteredStatus>
      <Spinner className="size-4" />
      Opening {snapshot.name}…
    </CenteredStatus>
  );
}

export function FirstmatePage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const snapshotQuery = useFirstmateSnapshot(environmentId);
  const snapshot = snapshotQuery.data;
  if (snapshot === null) {
    return (
      <Page title="Firstmate">
        {snapshotQuery.error ? (
          <Empty size="compact" className="min-h-full">
            <EmptyHeader>
              <EmptyTitle>Firstmate isn't available</EmptyTitle>
              <EmptyDescription>
                This server doesn't run Firstmate, or it couldn't be reached.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <CenteredStatus>
            <Spinner className="size-4" />
            Loading Firstmate…
          </CenteredStatus>
        )}
      </Page>
    );
  }
  return (
    <Page title={snapshot.name}>
      {snapshot.coordinatorThreadId === null ? (
        <FirstmateSetup environmentId={environmentId} snapshot={snapshot} />
      ) : (
        <ForwardToCoordinator
          environmentId={environmentId}
          snapshot={snapshot}
          coordinatorThreadId={snapshot.coordinatorThreadId}
        />
      )}
    </Page>
  );
}
