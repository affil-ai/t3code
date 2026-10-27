import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  composerOwnsShortcutEvent,
  isInsideOtherChat,
  noteFocusScopePointerDown,
  resolveFocusScope,
} from "./composerEventScope";

class FakeTreeNode {
  isConnected = true;

  constructor(
    readonly parent: FakeTreeNode | null,
    private readonly selector: string | null = null,
  ) {}

  closest(selector: string): FakeTreeNode | null {
    const selectors = selector.split(",");
    for (let node: FakeTreeNode | null = this; node; node = node.parent) {
      if (node.selector !== null && selectors.includes(node.selector)) return node;
    }
    return null;
  }

  contains(other: FakeTreeNode): boolean {
    for (let node: FakeTreeNode | null = other; node; node = node.parent) {
      if (node === this) return true;
    }
    return false;
  }
}

function buildChatTree() {
  const html = new FakeTreeNode(null);
  const body = new FakeTreeNode(html);
  const mainRoot = new FakeTreeNode(body, '[data-chat-root="true"]');
  const mainForm = new FakeTreeNode(mainRoot);
  const mainEditor = new FakeTreeNode(mainForm);
  const dockScope = new FakeTreeNode(body, '[data-chat-composer-focus-scope="true"]');
  const dockRoot = new FakeTreeNode(dockScope, '[data-chat-root="true"]');
  const dockForm = new FakeTreeNode(dockRoot);
  const dockEditor = new FakeTreeNode(dockForm);
  const dockMenu = new FakeTreeNode(body, '[data-chat-composer-floating-layer="true"]');
  return {
    html,
    body,
    mainRoot,
    mainForm,
    mainEditor,
    dockScope,
    dockRoot,
    dockForm,
    dockEditor,
    dockMenu,
  };
}

const asTarget = (node: FakeTreeNode) => node as unknown as EventTarget;
const asElement = (node: FakeTreeNode) => node as unknown as Element;

describe("composer shortcut ownership", () => {
  afterEach(() => {
    noteFocusScopePointerDown(null);
  });

  it("gives a focus-scoped composer only the events from inside it", () => {
    vi.stubGlobal("Element", FakeTreeNode);
    vi.stubGlobal("Node", FakeTreeNode);
    const { body, mainForm, mainEditor, dockForm, dockEditor } = buildChatTree();
    const owns = (form: FakeTreeNode, target: FakeTreeNode) =>
      composerOwnsShortcutEvent(asElement(form), asTarget(target));

    expect(owns(mainForm, mainEditor)).toBe(true);
    expect(owns(mainForm, body)).toBe(true);
    expect(owns(mainForm, dockEditor)).toBe(false);
    expect(owns(dockForm, dockEditor)).toBe(true);
    expect(owns(dockForm, mainEditor)).toBe(false);
    expect(owns(dockForm, body)).toBe(false);
  });

  it("routes document-level events to the chat the user last pressed in", () => {
    vi.stubGlobal("Element", FakeTreeNode);
    vi.stubGlobal("Node", FakeTreeNode);
    const { html, body, mainForm, mainEditor, dockScope, dockForm, dockEditor, dockMenu } =
      buildChatTree();
    vi.stubGlobal("document", { body, documentElement: html });
    const owns = (form: FakeTreeNode, target: FakeTreeNode | null) =>
      composerOwnsShortcutEvent(asElement(form), target === null ? null : asTarget(target));

    expect(resolveFocusScope(asTarget(body))).toBeNull();

    noteFocusScopePointerDown(asTarget(dockEditor));
    expect(resolveFocusScope(asTarget(body))).toBe(dockScope);
    expect(owns(dockForm, body)).toBe(true);
    expect(owns(dockForm, html)).toBe(true);
    expect(owns(dockForm, null)).toBe(true);
    expect(owns(mainForm, body)).toBe(false);
    // An element outside every scope still belongs to the main chat.
    expect(owns(mainForm, mainEditor)).toBe(true);

    // A press in the dock's portaled menu keeps the dock as the last chat.
    noteFocusScopePointerDown(asTarget(dockMenu));
    expect(resolveFocusScope(asTarget(body))).toBe(dockScope);

    // A dock that has unmounted no longer claims the body.
    dockScope.isConnected = false;
    expect(owns(mainForm, body)).toBe(true);
    dockScope.isConnected = true;

    noteFocusScopePointerDown(asTarget(mainEditor));
    expect(owns(mainForm, body)).toBe(true);
    expect(owns(dockForm, body)).toBe(false);
  });
});

describe("chat roots", () => {
  it("recognizes a press in the other chat", () => {
    vi.stubGlobal("Element", FakeTreeNode);
    const { body, mainRoot, mainEditor, dockRoot, dockEditor, dockMenu } = buildChatTree();

    expect(isInsideOtherChat(asElement(mainRoot), asTarget(dockEditor))).toBe(true);
    expect(isInsideOtherChat(asElement(dockRoot), asTarget(mainEditor))).toBe(true);
    expect(isInsideOtherChat(asElement(mainRoot), asTarget(mainEditor))).toBe(false);
    expect(isInsideOtherChat(asElement(dockRoot), asTarget(dockEditor))).toBe(false);
    // Menus and chrome outside both chats rest nothing.
    expect(isInsideOtherChat(asElement(mainRoot), asTarget(dockMenu))).toBe(false);
    expect(isInsideOtherChat(asElement(mainRoot), asTarget(body))).toBe(false);
    expect(isInsideOtherChat(null, asTarget(dockEditor))).toBe(false);
  });
});
