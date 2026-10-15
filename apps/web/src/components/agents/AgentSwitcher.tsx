/**
 * The Work sidebar's agent row, under Search: the selected agent drawn as a
 * large row (icon tile, name, status, a badge counting tasks waiting on the
 * user), with a switcher that lists every agent and creates, edits, or
 * archives one. Firstmate is the default and keeps the Work chat lists under
 * it; any other agent shows only its tasks and automations. The row opens
 * the agent's chat, or starts one for an agent whose chat is gone. It is
 * absent when no connected server runs agents.
 */
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AGENT_DEFAULT_COLOR,
  type AgentProfile,
  type EnvironmentId,
  FIRSTMATE_AGENT_ID,
} from "@t3tools/contracts";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArchiveIcon, CheckIcon, ChevronsUpDownIcon, PencilIcon, PlusIcon } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useSelectedAgentStore } from "~/selectedAgentStore";
import { useAgentByThreadKey, useAgentsHome, useAgentTasks } from "~/state/agents";
import { useFirstmateHome } from "~/state/firstmate";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { countFirstmateNeedsYou } from "../firstmate/firstmateBoard.logic";
import { FirstmateAppearanceDialog } from "../firstmate/FirstmateAppearanceDialog";
import { useFirstmateModelSelection } from "../firstmate/firstmateModel";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { SidebarMenu } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { AgentAvatar } from "./AgentAvatar";
import { useAgentCommands } from "./agentCommands";
import { AgentDialog } from "./AgentDialog";
import { AgentRowSubtitle, AgentSidebarRow } from "./AgentSidebarRow";
import { resolveSelectedAgent } from "./selectedAgent.logic";

type RowMenuAction = "edit" | "archive";

/** The selected agent, resolved once for the sidebar's row and sections. */
export function useSelectedAgent(): AgentProfile | null {
  const home = useAgentsHome();
  const selectedAgentId = useSelectedAgentStore((state) => state.selectedAgentId);
  const preferCustomAgent = useSelectedAgentStore((state) => state.preferCustomAgent);
  return home === null
    ? null
    : resolveSelectedAgent(home.agents, selectedAgentId, preferCustomAgent);
}

/** Tasks waiting on the user, from whichever stream holds the agent's board. */
function NeedsYouBadge({ agent }: { readonly agent: AgentProfile }) {
  const firstmate = agent.id === FIRSTMATE_AGENT_ID;
  const home = useFirstmateHome();
  const query = useAgentTasks(
    firstmate ? null : (home?.environmentId ?? null),
    firstmate ? null : agent.id,
  );
  const tasks = firstmate ? (home?.snapshot.tasks ?? []) : (query.data?.tasks ?? []);
  const needsYou = countFirstmateNeedsYou(tasks);
  if (needsYou === 0) return null;
  return (
    <Badge variant="warning" size="sm" aria-label={`${needsYou} need you`}>
      {needsYou}
    </Badge>
  );
}

/**
 * The row's element for an agent without a chat: a click starts one with the
 * model a fresh Scratch chat would open with. The row passes its class and
 * content in, as it does for a link.
 */
function StartAgentButton({
  environmentId,
  agent,
  name,
  className,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentProfile;
  readonly name: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const navigate = useNavigate();
  const modelSelection = useFirstmateModelSelection(environmentId);
  const { pending, start, run } = useAgentCommands();
  return (
    <button
      type="button"
      className={className}
      disabled={pending !== null || modelSelection === null}
      onClick={() => {
        if (modelSelection === null) return;
        void run(
          "start",
          () => start({ environmentId, input: { agentId: agent.id, modelSelection } }),
          `Could not start ${name}`,
        ).then((started) => {
          if (started === null) return;
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: started.threadId },
          });
        });
      }}
    >
      {children}
      {pending === "start" ? <Spinner className="size-3.5" /> : null}
    </button>
  );
}

export function AgentSwitcher() {
  const agentsHome = useAgentsHome();
  const firstmateHome = useFirstmateHome();
  const agent = useSelectedAgent();
  const selectAgent = useSelectedAgentStore((state) => state.selectAgent);
  const navigate = useNavigate();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;
  // The sidebar follows the open chat's agent, so back and forward (or a
  // link) between agents' chats switch the sidebar too.
  const agentByThreadKey = useAgentByThreadKey();
  const routeAgentId =
    routeThreadRef === null
      ? null
      : (agentByThreadKey.get(
          scopedThreadKey(scopeThreadRef(routeThreadRef.environmentId, routeThreadRef.threadId)),
        ) ?? null);
  useEffect(() => {
    if (routeAgentId === null || agent === null || routeAgentId === agent.id) return;
    selectAgent(routeAgentId === FIRSTMATE_AGENT_ID ? null : routeAgentId);
  }, [routeAgentId, agent, selectAgent]);
  const [dialog, setDialog] = useState<{ agent: AgentProfile | null } | null>(null);
  // The switcher opens on hover as well as click, so changing agents is one
  // motion. Leaving the trigger or the popup closes it after a short grace.
  const [menuOpen, setMenuOpen] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverTimer = () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const openOnHover = () => {
    cancelHoverTimer();
    hoverTimer.current = setTimeout(() => setMenuOpen(true), 120);
  };
  const closeAfterLeave = () => {
    cancelHoverTimer();
    hoverTimer.current = setTimeout(() => setMenuOpen(false), 220);
  };
  useEffect(() => cancelHoverTimer, []);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [archiving, setArchiving] = useState<AgentProfile | null>(null);
  const { pending, archive, run } = useAgentCommands();
  if (agentsHome === null || agent === null) return null;
  const { environmentId } = agentsHome;
  const firstmate = agent.id === FIRSTMATE_AGENT_ID;
  // Firstmate's own stream is authoritative for its name, icon, and chat.
  const name = firstmate ? (firstmateHome?.snapshot.name ?? agent.name) : agent.name;
  const icon = firstmate ? (firstmateHome?.snapshot.icon ?? agent.icon) : agent.icon;
  const coordinatorThreadId = firstmate
    ? (firstmateHome?.snapshot.coordinatorThreadId ?? agent.coordinatorThreadId)
    : agent.coordinatorThreadId;
  const onCoordinator =
    coordinatorThreadId !== null && routeKey === `${environmentId}:${coordinatorThreadId}`;

  const openEditor = (target: AgentProfile) => {
    if (target.id === FIRSTMATE_AGENT_ID) setAppearanceOpen(true);
    else setDialog({ agent: target });
  };
  const showRowMenu = (event: MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) {
      openEditor(agent);
      return;
    }
    void api.contextMenu
      .show<RowMenuAction>(
        [
          { id: "edit", label: firstmate ? "Name and icon…" : "Edit name, role, and icon…" },
          ...(firstmate ? [] : [{ id: "archive" as const, label: "Archive agent" }]),
        ],
        { x: event.clientX, y: event.clientY },
      )
      .then((clicked) => {
        if (clicked === "edit") openEditor(agent);
        if (clicked === "archive") setArchiving(agent);
      });
  };
  const switchTo = (target: AgentProfile) => {
    selectAgent(target.id === FIRSTMATE_AGENT_ID ? null : target.id);
    const threadId =
      target.id === FIRSTMATE_AGENT_ID
        ? (firstmateHome?.snapshot.coordinatorThreadId ?? target.coordinatorThreadId)
        : target.coordinatorThreadId;
    if (threadId === null) {
      if (target.id === FIRSTMATE_AGENT_ID) {
        void navigate({ to: "/firstmate/$environmentId", params: { environmentId } });
      }
      return;
    }
    void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
  };

  return (
    // A second menu under Search: mt-1 matches the gap between rows in one menu.
    <SidebarMenu className="relative mt-1" data-testid="agent-switcher">
      <AgentSidebarRow
        className="mb-0"
        icon={icon}
        color={agent.color ?? AGENT_DEFAULT_COLOR}
        name={name}
        subtitle={
          <AgentRowSubtitle
            environmentId={environmentId}
            agent={{ coordinatorThreadId, role: agent.role }}
            fallback={firstmate ? "Your coordinator" : "Agent"}
          />
        }
        trailing={
          // Room for the switcher button, which sits over the row's right edge.
          <span className="flex items-center gap-1 pr-7">
            <NeedsYouBadge agent={agent} />
          </span>
        }
        active={onCoordinator}
        onContextMenu={showRowMenu}
        link={
          coordinatorThreadId === null ? (
            firstmate ? (
              <Link
                to="/firstmate/$environmentId"
                params={{ environmentId }}
                activeProps={{ "data-active": true }}
              />
            ) : (
              // An agent whose chat is gone, or that never started: a click starts one.
              <StartAgentButton environmentId={environmentId} agent={agent} name={name} />
            )
          ) : (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: coordinatorThreadId }}
              {...(onCoordinator ? { "data-active": true } : {})}
            />
          )
        }
      />
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          onPointerEnter={openOnHover}
          onPointerLeave={closeAfterLeave}
          render={
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Switch agent"
              title="Switch agent"
              data-testid="agent-switcher-trigger"
              className="absolute top-1/2 right-2 -translate-y-1/2"
            />
          }
        >
          <ChevronsUpDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup
          align="start"
          className="w-64"
          onPointerEnter={cancelHoverTimer}
          onPointerLeave={closeAfterLeave}
        >
          {/* A group label needs its group; Base UI throws otherwise. */}
          <MenuGroup>
            <MenuGroupLabel>Agents</MenuGroupLabel>
            {agentsHome.agents.map((candidate) => {
              const current = candidate.id === agent.id;
              const candidateFirstmate = candidate.id === FIRSTMATE_AGENT_ID;
              return (
                <MenuItem key={candidate.id} onClick={() => switchTo(candidate)}>
                  <AgentAvatar
                    icon={candidateFirstmate ? icon : candidate.icon}
                    color={candidate.color ?? AGENT_DEFAULT_COLOR}
                    className="size-7 rounded-lg"
                    iconClassName="size-4"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={cn("truncate font-medium", !current && "font-normal")}>
                      {candidateFirstmate ? name : candidate.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {candidate.coordinatorThreadId === null
                        ? "Not started"
                        : candidate.role.split("\n")[0] ||
                          (candidateFirstmate ? "Your coordinator" : "Agent")}
                    </span>
                  </span>
                  {current ? <CheckIcon className="size-4 shrink-0" /> : null}
                </MenuItem>
              );
            })}
          </MenuGroup>
          <MenuSeparator />
          <MenuItem onClick={() => setDialog({ agent: null })}>
            <PlusIcon className="size-4" />
            New agent…
          </MenuItem>
          <MenuItem onClick={() => openEditor(agent)}>
            <PencilIcon className="size-4" />
            {firstmate ? "Name and icon…" : "Edit name, role, and icon…"}
          </MenuItem>
          {firstmate ? null : (
            <MenuItem onClick={() => setArchiving(agent)}>
              <ArchiveIcon className="size-4" />
              Archive agent
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
      {firstmateHome !== null ? (
        <FirstmateAppearanceDialog
          environmentId={firstmateHome.environmentId}
          name={firstmateHome.snapshot.name}
          icon={firstmateHome.snapshot.icon}
          open={appearanceOpen}
          onOpenChange={setAppearanceOpen}
        />
      ) : null}
      {dialog !== null ? (
        <AgentDialog
          environmentId={environmentId}
          agent={dialog.agent}
          open
          onOpenChange={(open) => {
            if (!open) setDialog(null);
          }}
        />
      ) : null}
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
              The agent leaves the switcher. Its chat, folder, and tasks stay on the server.
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
                ).then((archived) => {
                  setArchiving(null);
                  // The sidebar goes back to Firstmate once its agent is gone.
                  if (archived !== null) selectAgent(null);
                });
              }}
            >
              {pending === "archive" ? <Spinner className="size-3.5" /> : null}
              Archive
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SidebarMenu>
  );
}
