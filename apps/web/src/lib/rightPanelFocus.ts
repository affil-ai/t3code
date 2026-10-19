import { isPreviewFocused } from "./previewFocus";

/** Menu action the desktop app sends when the shortcut is pressed inside a browser tab. */
export const RIGHT_PANEL_TOGGLE_FOCUS_ACTION = "right-panel.toggle-focus";

// What to focus in a surface, most specific first: a browser tab's page, a
// terminal's input, then an editor. Anything else focuses the content itself.
const FOCUS_TARGETS = ["webview", "textarea", '[contenteditable="true"]'];

let rememberedTarget: HTMLElement | null = null;

function isShown(element: HTMLElement): boolean {
  return element.checkVisibility?.({ visibilityProperty: true }) ?? true;
}

/** Whether keyboard focus is anywhere in the right panel, including a browser tab's page. */
export function isRightPanelFocused(): boolean {
  return isPreviewFocused();
}

/** Remembers where focus is in the panel so the next switch back returns there. */
export function rememberRightPanelFocus(): void {
  const active = document.activeElement;
  rememberedTarget = active instanceof HTMLElement ? active : null;
}

/** Moves focus into the right panel's active surface. Returns false when no panel is rendered. */
export function focusRightPanel(): boolean {
  const content = document.querySelector<HTMLElement>("[data-right-panel-surface-content]");
  if (!content) return false;
  const remembered = rememberedTarget;
  if (remembered?.isConnected && content.contains(remembered) && isShown(remembered)) {
    remembered.focus({ preventScroll: true });
    return true;
  }
  for (const selector of FOCUS_TARGETS) {
    const target = Array.from(content.querySelectorAll<HTMLElement>(selector)).find(isShown);
    if (target) {
      target.focus({ preventScroll: true });
      return true;
    }
  }
  content.focus({ preventScroll: true });
  return true;
}
