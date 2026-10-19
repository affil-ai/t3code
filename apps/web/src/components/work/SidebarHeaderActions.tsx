import { useAtomValue } from "@effect/atom-react";
import { SearchIcon } from "lucide-react";

import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { HistoryNavButtons } from "../HistoryNavButtons";
import { Button } from "../ui/button";
import { CommandDialogTrigger } from "../ui/command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Search stays in the titlebar on phones, where history buttons are hidden. */
export function SidebarHeaderActions() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcut = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  return (
    <div className="relative z-10 ml-auto flex shrink-0 items-center gap-0.5 pr-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <CommandDialogTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-sm"
                  aria-label="Search"
                  data-testid="command-palette-trigger"
                  className="[-webkit-app-region:no-drag]"
                />
              }
            />
          }
        >
          <SearchIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{shortcut ? `Search (${shortcut})` : "Search"}</TooltipPopup>
      </Tooltip>
      <HistoryNavButtons className="hidden md:flex" />
    </div>
  );
}
