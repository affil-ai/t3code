import { Link } from "@tanstack/react-router";
import { ShipWheelIcon } from "lucide-react";

import { useFirstmateHome } from "../../state/firstmate";
import { Badge } from "../ui/badge";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { countFirstmateNeedsYou } from "./firstmateBoard.logic";

/**
 * The Work sidebar's Firstmate row, under Search. It opens the board on the
 * first environment that serves Firstmate and is absent when none does.
 */
export function FirstmateSidebarLink() {
  const home = useFirstmateHome();
  if (home === null) return null;
  const needsYou = countFirstmateNeedsYou(home.snapshot.tasks);
  return (
    // A second menu under Search: mt-1 matches the gap between rows in one menu.
    <SidebarMenu className="mt-1">
      <SidebarMenuItem>
        <SidebarMenuButton
          render={
            <Link
              to="/firstmate/$environmentId"
              params={{ environmentId: home.environmentId }}
              activeProps={{ "data-active": true }}
            />
          }
        >
          <ShipWheelIcon />
          <span className="flex-1 truncate">Firstmate</span>
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
