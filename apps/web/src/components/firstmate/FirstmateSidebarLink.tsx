import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { resolveThreadRouteRef } from "~/threadRoutes";
import { useFirstmateHome } from "../../state/firstmate";
import { Badge } from "../ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { countFirstmateNeedsYou } from "./firstmateBoard.logic";
import { openFirstmateTasks } from "./firstmateCommands";
import { FirstmateIcon } from "./firstmateIcons";

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
 * The Work sidebar's Firstmate row, under Search, with the user's chosen name
 * and icon. It opens the coordinator chat with its Tasks tab, or the start
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
  if (home === null) return null;
  const { environmentId, snapshot } = home;
  const coordinatorThreadId = snapshot.coordinatorThreadId;
  const needsYou = countFirstmateNeedsYou(snapshot.tasks);
  const onCoordinator =
    coordinatorThreadId !== null && routeKey === `${environmentId}:${coordinatorThreadId}`;
  return (
    // A second menu under Search: mt-1 matches the gap between rows in one menu.
    <SidebarMenu className="mt-1">
      <SidebarMenuItem>
        <SidebarMenuButton
          render={
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
        >
          <FirstmateIcon icon={snapshot.icon} />
          <span className="flex-1 truncate">{snapshot.name}</span>
          {needsYou > 0 ? (
            <Badge variant="warning" size="sm" aria-label={`${needsYou} need you`}>
              {needsYou}
            </Badge>
          ) : null}
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
