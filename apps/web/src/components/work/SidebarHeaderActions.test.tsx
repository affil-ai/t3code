// @vitest-environment jsdom

import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CommandDialog, CommandDialogPopup } from "../ui/command";
import { SidebarHeaderActions } from "./SidebarHeaderActions";

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => DEFAULT_RESOLVED_KEYBINDINGS,
}));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    history: {
      location: { state: { __TSR_index: 0 } },
      subscribe: () => () => {},
    },
  }),
  useLocation: ({ select }: { select: (location: object) => unknown }) =>
    select({ state: { __TSR_index: 0 } }),
}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sidebar header search", () => {
  it("opens search from the icon before the history buttons and closes on Escape", async () => {
    await act(() =>
      root.render(
        <CommandDialog>
          <SidebarHeaderActions />
          <CommandDialogPopup aria-label="Search chats">
            <input aria-label="Search query" />
          </CommandDialogPopup>
        </CommandDialog>,
      ),
    );
    expect(
      [...container.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Search", "Go back", "Go forward"]);
    const search = container.querySelector<HTMLButtonElement>('[aria-label="Search"]')!;
    expect(search.textContent).toBe("");
    expect(search.querySelector("svg")).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(() => {
      search.focus();
      search.click();
    });
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe(
      "Search chats",
    );
    const query = document.querySelector<HTMLInputElement>('[aria-label="Search query"]')!;
    await act(() => {
      query.value = "mobile";
      query.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(query.value).toBe("mobile");
    await act(() =>
      query.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    expect(document.querySelector('[role="dialog"]:not([data-closed])')).toBeNull();
  });
});
