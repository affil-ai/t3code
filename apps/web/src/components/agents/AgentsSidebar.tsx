/**
 * Agents mode's sidebar: one large row per agent, with a colored icon tile,
 * the agent's name, and its role or status underneath, the way Grok Bot lists
 * its bots. There is no search or header; a "New agent" row under the list creates one, and a
 * right-click offers edit and archive. Firstmate has its own place in Work
 * mode, so it is left out here.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AgentProfile,
  type EnvironmentId,
  FIRSTMATE_AGENT_ID,
  type ThreadId,
} from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useAgentsHome, useAgentTasks } from "~/state/agents";
import { useThreadShell } from "~/state/entities";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { useFirstmateModelSelection } from "../firstmate/firstmateModel";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarContent, SidebarGroup, SidebarMenu } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { AgentSidebarRow } from "./AgentSidebarRow";
import { openAgentTasks, useAgentCommands } from "./agentCommands";
import { AgentDialog } from "./AgentDialog";

type RowMenuAction = "edit" | "archive";

/** Opens the Tasks tab each time an agent's chat becomes the route. */
function useOpenTasksBesideAgent(
  environmentId: EnvironmentId | null,
  agents: ReadonlyArray<AgentProfile>,
  routeKey: string | null,
) {
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (environmentId === null || routeKey === null) {
      openedFor.current = null;
      return;
    }
    const agent = agents.find(
      (candidate) =>
        candidate.coordinatorThreadId !== null &&
        `${environmentId}:${candidate.coordinatorThreadId}` === routeKey,
    );
    if (agent === undefined || agent.coordinatorThreadId === null) {
      openedFor.current = null;
      return;
    }
    if (openedFor.current === routeKey) return;
    openedFor.current = routeKey;
    openAgentTasks(environmentId, agent.coordinatorThreadId);
  }, [agents, environmentId, routeKey]);
}

/** The role on one line, or the chat's live status when it is doing something. */
export function AgentRowSubtitle({
  environmentId,
  agent,
  fallback = "Agent",
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: Pick<AgentProfile, "coordinatorThreadId" | "role">;
  readonly fallback?: string;
}) {
  const shell = useThreadShell(
    agent.coordinatorThreadId === null
      ? null
      : scopeThreadRef(environmentId, agent.coordinatorThreadId),
  );
  const status = shell === null ? null : resolveThreadStatusPill({ thread: shell });
  const live =
    status !== null &&
    (status.label === "Working" ||
      status.label === "Connecting" ||
      status.label === "Pending Approval" ||
      status.label === "Awaiting Input" ||
      status.label === "Failed");
  if (live) {
    return (
      <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", status.colorClass)}>
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status.dotClass,
            status.pulse && "animate-pulse",
          )}
        />
        <span className="truncate">{status.label}</span>
      </span>
    );
  }
  if (agent.coordinatorThreadId === null) {
    return <span className="truncate text-xs text-sidebar-muted-foreground/70">Not started</span>;
  }
  return (
    <span className="truncate text-xs text-sidebar-muted-foreground/80">
      {agent.role.split("\n")[0] || fallback}
    </span>
  );
}

function AgentRow({
  environmentId,
  agent,
  active,
  routeKey,
  onMenu,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentProfile;
  readonly active: boolean;
  readonly routeKey: string | null;
  readonly onMenu: (agent: AgentProfile, event: MouseEvent) => void;
}) {
  const navigate = useNavigate();
  const modelSelection = useFirstmateModelSelection(environmentId);
  const { pending, start, run } = useAgentCommands();
  const tasks = useAgentTasks(environmentId, agent.id).data?.tasks ?? null;
  return (
    <AgentSidebarRow
      environmentId={environmentId}
      icon={agent.icon}
      color={agent.color}
      name={agent.name}
      subtitle={<AgentRowSubtitle environmentId={environmentId} agent={agent} />}
      trailing={pending === "start" ? <Spinner className="size-3.5" /> : null}
      active={active}
      coordinatorThreadId={agent.coordinatorThreadId}
      tasks={tasks}
      activeRouteKey={routeKey}
      defaultExpanded
      onContextMenu={(event) => onMenu(agent, event)}
      link={
        agent.coordinatorThreadId === null ? (
          // An agent whose chat is gone, or that never started: a click starts one.
          <button
            type="button"
            disabled={pending !== null || modelSelection === null}
            onClick={() => {
              if (modelSelection === null) return;
              void run(
                "start",
                () => start({ environmentId, input: { agentId: agent.id, modelSelection } }),
                `Could not start ${agent.name}`,
              ).then((started) => {
                if (started === null) return;
                openAgentTasks(environmentId, started.threadId);
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: started.threadId },
                });
              });
            }}
          />
        ) : (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: agent.coordinatorThreadId }}
            onClick={() => openAgentTasks(environmentId, agent.coordinatorThreadId as ThreadId)}
            {...(active ? { "data-active": true } : {})}
          />
        )
      }
    />
  );
}

export function AgentsSidebar() {
  const home = useAgentsHome();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;
  const agents = (home?.agents ?? []).filter((agent) => agent.id !== FIRSTMATE_AGENT_ID);
  useOpenTasksBesideAgent(home?.environmentId ?? null, agents, routeKey);
  const [dialog, setDialog] = useState<{ agent: AgentProfile | null } | null>(null);
  const [archiving, setArchiving] = useState<AgentProfile | null>(null);
  const { pending, archive, run } = useAgentCommands();

  const showRowMenu = (agent: AgentProfile, event: MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    const apply = (clicked: RowMenuAction | null) => {
      if (clicked === "edit") setDialog({ agent });
      if (clicked === "archive") setArchiving(agent);
    };
    if (!api) {
      apply("edit");
      return;
    }
    void api.contextMenu
      .show<RowMenuAction>(
        [
          { id: "edit", label: "Edit name, role, and icon…" },
          { id: "archive", label: "Archive agent" },
        ],
        { x: event.clientX, y: event.clientY },
      )
      .then(apply);
  };

  const environmentId = home?.environmentId ?? null;
  return (
    <SidebarContent>
      <SidebarGroup>
        {home === null ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>Agents aren't available</EmptyTitle>
              <EmptyDescription>
                No connected server runs agents, or it is still connecting.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : agents.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>No agents yet</EmptyTitle>
              <EmptyDescription>
                Create one with a role. Each agent is a chat with its own task board.
              </EmptyDescription>
            </EmptyHeader>
            <Button size="sm" onClick={() => setDialog({ agent: null })}>
              <PlusIcon />
              New agent
            </Button>
          </Empty>
        ) : (
          <SidebarMenu>
            {agents.map((agent) => (
              <AgentRow
                key={agent.id}
                environmentId={home.environmentId}
                agent={agent}
                active={
                  agent.coordinatorThreadId !== null &&
                  routeKey === `${home.environmentId}:${agent.coordinatorThreadId}`
                }
                routeKey={routeKey}
                onMenu={showRowMenu}
              />
            ))}
            <li>
              <button
                type="button"
                onClick={() => setDialog({ agent: null })}
                className="flex h-10 w-full cursor-pointer items-center gap-3 rounded-xl px-2 text-left text-sm text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset"
              >
                <span className="inline-flex size-9 shrink-0 items-center justify-center">
                  <PlusIcon className="size-4" />
                </span>
                New agent
              </button>
            </li>
          </SidebarMenu>
        )}
      </SidebarGroup>
      {environmentId !== null && dialog !== null ? (
        <AgentDialog
          environmentId={environmentId}
          agent={dialog.agent}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        />
      ) : null}
      {environmentId !== null ? (
        <AlertDialog
          open={archiving !== null}
          onOpenChange={(open) => {
            if (!open) setArchiving(null);
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Archive {archiving?.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                The agent leaves this list. Its chat, folder, and tasks stay on the server.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button
                variant="destructive"
                disabled={pending !== null}
                onClick={() => {
                  if (archiving === null) return;
                  void run(
                    "archive",
                    () => archive({ environmentId, input: { agentId: archiving.id } }),
                    `Could not archive ${archiving.name}`,
                  ).then(() => setArchiving(null));
                }}
              >
                {pending === "archive" ? <Spinner className="size-3.5" /> : null}
                Archive
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </SidebarContent>
  );
}
