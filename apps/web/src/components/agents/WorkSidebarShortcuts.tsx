/** Fork navigation uses the configurable shortcuts, not fixed key checks. */
import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_JUMP_KEYBINDING_COMMANDS,
  type AgentProfile,
  type KeybindingCommand,
} from "@t3tools/contracts";
import { useEffect } from "react";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { resolveShortcutCommand } from "~/keybindings";
import { isEditableFocused } from "~/lib/editableFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { isModelPickerOpen } from "~/modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useWorkModeStore } from "~/workModeStore";

export function useWorkSidebarShortcut(onCommand: (command: KeybindingCommand) => boolean) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        useWorkModeStore.getState().mode !== "work" ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        isCommandPaletteOpen() ||
        isModelPickerOpen() ||
        isTerminalFocused() ||
        document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
      )
        return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { workMode: true, editableFocus: isEditableFocused(event.target) },
      });
      if (command === null || !onCommand(command)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, onCommand]);
}

export function AgentJumpShortcuts({
  agents,
  onSelect,
}: {
  readonly agents: readonly AgentProfile[];
  readonly onSelect: (agent: AgentProfile) => void;
}) {
  useWorkSidebarShortcut((command) => {
    const index = AGENT_JUMP_KEYBINDING_COMMANDS.findIndex((candidate) => candidate === command);
    if (index < 0) return false;
    const target = agents[index];
    if (target) onSelect(target);
    // An empty slot must not fall through to a thread shortcut.
    return true;
  });
  return null;
}
