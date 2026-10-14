import { AGENT_DEFAULT_COLOR, FIRSTMATE_AGENT_ID } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { type MouseEvent, useEffect, useRef, useState } from "react";

import { readLocalApi } from "~/localApi";
import { useAgentsHome } from "~/state/agents";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { useFirstmateHome } from "../../state/firstmate";
import { AgentSidebarRow } from "../agents/AgentSidebarRow";
import { AgentRowSubtitle } from "../agents/AgentsSidebar";
import { Badge } from "../ui/badge";
import { SidebarMenu } from "../ui/sidebar";
import { countFirstmateNeedsYou } from "./firstmateBoard.logic";
import { openFirstmateTasks } from "./firstmateCommands";
import { FirstmateAppearanceDialog } from "./FirstmateAppearanceDialog";

/**
 * Opens the Tasks tab each time the coordinator chat becomes the route, so
 * it is there however the user got to the chat. Closing the tab sticks until
 * the user leaves the chat and comes back.
 */
function useOpenTasksBesideCoordinator(
  home: ReturnType<typeof useFirstmateHome>,
  routeKey: string | null,
) {
  const coordinatorKey =
    home?.snapshot.coordinatorThreadId == null
      ? null
      : `${home.environmentId}:${home.snapshot.coordinatorThreadId}`;
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    const onCoordinator = coordinatorKey !== null && routeKey === coordinatorKey;
    if (!onCoordinator) {
      openedFor.current = null;
      return;
    }
    if (openedFor.current === coordinatorKey || !home?.snapshot.coordinatorThreadId) return;
    openedFor.current = coordinatorKey;
    openFirstmateTasks(home.environmentId, home.snapshot.coordinatorThreadId);
  }, [coordinatorKey, home, routeKey]);
}

/**
 * The Work sidebar's Firstmate row, under Search, drawn like an agent in
 * Agents mode (icon tile, name, status, and its open tasks folded under it)
 * so it doesn't read as an ordinary chat. It opens the coordinator chat with its Tasks tab, or the start
 * page when there is no coordinator, on the first environment that serves
 * Firstmate. It is absent when none does.
 */
export function FirstmateSidebarLink() {
  const home = useFirstmateHome();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;
  useOpenTasksBesideCoordinator(home, routeKey);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const profile = useAgentsHome()?.agents.find((agent) => agent.id === FIRSTMATE_AGENT_ID) ?? null;
  if (home === null) return null;
  const { environmentId, snapshot } = home;
  const coordinatorThreadId = snapshot.coordinatorThreadId;
  const needsYou = countFirstmateNeedsYou(snapshot.tasks);
  const onCoordinator =
    coordinatorThreadId !== null && routeKey === `${environmentId}:${coordinatorThreadId}`;
  const showRowMenu = (event: MouseEvent) => {
    event.preventDefault();
    const api = readLocalApi();
    if (!api) {
      setAppearanceOpen(true);
      return;
    }
    void api.contextMenu
      .show([{ id: "appearance", label: "Name and icon…" }], {
        x: event.clientX,
        y: event.clientY,
      })
      .then((clicked) => {
        if (clicked === "appearance") setAppearanceOpen(true);
      });
  };
  return (
    // A second menu under Search: mt-1 matches the gap between rows in one menu.
    <SidebarMenu className="mt-1">
      <AgentSidebarRow
        className="mb-0"
        environmentId={environmentId}
        icon={snapshot.icon}
        color={profile?.color ?? AGENT_DEFAULT_COLOR}
        name={snapshot.name}
        subtitle={
          <AgentRowSubtitle
            environmentId={environmentId}
            agent={{ coordinatorThreadId, role: profile?.role ?? "" }}
            fallback="Your coordinator"
          />
        }
        trailing={
          needsYou > 0 ? (
            <Badge variant="warning" size="sm" aria-label={`${needsYou} need you`}>
              {needsYou}
            </Badge>
          ) : null
        }
        active={onCoordinator}
        coordinatorThreadId={coordinatorThreadId}
        tasks={snapshot.tasks}
        activeRouteKey={routeKey}
        defaultExpanded={false}
        onContextMenu={showRowMenu}
        link={
          coordinatorThreadId === null ? (
            <Link
              to="/firstmate/$environmentId"
              params={{ environmentId }}
              activeProps={{ "data-active": true }}
            />
          ) : (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId, threadId: coordinatorThreadId }}
              onClick={() => openFirstmateTasks(environmentId, coordinatorThreadId)}
              {...(onCoordinator ? { "data-active": true } : {})}
            />
          )
        }
      />
      <FirstmateAppearanceDialog
        environmentId={environmentId}
        name={snapshot.name}
        icon={snapshot.icon}
        open={appearanceOpen}
        onOpenChange={setAppearanceOpen}
      />
    </SidebarMenu>
  );
}
