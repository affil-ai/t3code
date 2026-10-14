import { AGENT_DEFAULT_COLOR, FIRSTMATE_AGENT_ID } from "@t3tools/contracts";
import { Link, useParams } from "@tanstack/react-router";
import { type MouseEvent, useState } from "react";

import { readLocalApi } from "~/localApi";
import { useAgentsHome } from "~/state/agents";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { useFirstmateHome } from "../../state/firstmate";
import { AgentSidebarRow } from "../agents/AgentSidebarRow";
import { AgentTaskTree } from "../agents/AgentTaskTree";
import { AgentRowSubtitle } from "../agents/AgentsSidebar";
import { Badge } from "../ui/badge";
import { SidebarGroup, SidebarMenu } from "../ui/sidebar";
import { countFirstmateNeedsYou } from "./firstmateBoard.logic";
import { FirstmateAppearanceDialog } from "./FirstmateAppearanceDialog";

/**
 * The Work sidebar's Firstmate row, under Search, drawn like an agent in
 * Agents mode (icon tile, name, status) so it doesn't read as an ordinary
 * chat. Its open tasks follow in `FirstmateSidebarTasks`. It opens the coordinator chat, or the start
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

/**
 * Firstmate's open tasks, the first group of the Work sidebar's list: under
 * the Firstmate row and ahead of Pinned, Projects, and Chats. A task opens its
 * worker's chat. It is absent until Firstmate has a chat.
 */
export function FirstmateSidebarTasks() {
  const home = useFirstmateHome();
  const routeKey = useParams({
    strict: false,
    select: (params) => {
      const ref = resolveThreadRouteRef(params);
      return ref ? `${ref.environmentId}:${ref.threadId}` : null;
    },
  });
  const coordinatorThreadId = home?.snapshot.coordinatorThreadId ?? null;
  if (home === null || coordinatorThreadId === null) return null;
  return (
    <SidebarGroup aria-label={`${home.snapshot.name}'s tasks`} className="mb-3">
      <AgentTaskTree
        environmentId={home.environmentId}
        coordinatorThreadId={coordinatorThreadId}
        tasks={home.snapshot.tasks}
        activeRouteKey={routeKey}
      />
    </SidebarGroup>
  );
}
