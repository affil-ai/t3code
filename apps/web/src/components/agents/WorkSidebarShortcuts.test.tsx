// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { useWorkModeStore } from "~/workModeStore";
import { useWorkSidebarShortcut } from "./WorkSidebarShortcuts";

vi.mock("~/env", async (original) => ({
  ...(await original<typeof import("~/env")>()),
  isElectron: true,
}));
vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    primaryServerKeybindingsAtom: Atom.make(
      mergeWithDefaultKeybindings([
        ...DEFAULT_RESOLVED_KEYBINDINGS,
        ...compileResolvedKeybindingsConfig([
          { key: "mod+2", command: "thread.jump.2" },
          {
            key: "mod+arrowdown",
            command: "task.next",
            when: "workMode && !editableFocus && !terminalFocus && !previewFocus && !modelPickerOpen",
          },
        ]),
      ]),
    ),
  };
});

let root: Root;
let container: HTMLDivElement;
const select = vi.fn();
function Harness() {
  useWorkSidebarShortcut((command) => {
    select(command);
    return true;
  });
  return <input aria-label="Editor" />;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  useWorkModeStore.setState({ mode: "work" });
  select.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<Harness />));
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  useWorkModeStore.setState({ mode: "code" });
  vi.unstubAllGlobals();
});
it("dispatches agent selection with the persisted legacy thread rules", async () => {
  const event = new KeyboardEvent("keydown", {
    key: "2",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(() => document.body.dispatchEvent(event));
  expect(select).toHaveBeenCalledWith("agent.jump.2");
  expect(event.defaultPrevented).toBe(true);
});
it("dispatches task traversal after agent selection focuses the editor", async () => {
  await act(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", metaKey: true, bubbles: true }),
    ),
  );
  expect(select).toHaveBeenCalledWith("task.next");
  select.mockReset();
  container.querySelector("input")!.focus();
  await act(() =>
    container
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "2", metaKey: true, bubbles: true })),
  );
  expect(select).toHaveBeenCalledWith("agent.jump.2");
  select.mockReset();
  await act(() =>
    container
      .querySelector("input")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", metaKey: true, bubbles: true }),
      ),
  );
  expect(select).toHaveBeenCalledWith("task.next");
  select.mockReset();
  await act(() =>
    container
      .querySelector("input")!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", metaKey: true, bubbles: true }),
      ),
  );
  expect(select).toHaveBeenCalledWith("task.previous");
});
it("does not handle Work shortcuts in Code mode or an open dialog", async () => {
  useWorkModeStore.setState({ mode: "code" });
  await act(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", metaKey: true, bubbles: true }),
    ),
  );
  expect(select).not.toHaveBeenCalled();
  useWorkModeStore.setState({ mode: "work" });
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  container.append(dialog);
  await act(() =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", metaKey: true, bubbles: true }),
    ),
  );
  expect(select).not.toHaveBeenCalled();
});
