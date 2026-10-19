import { useComposerHandleContext } from "../../composerHandleContext";

const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-chat-composer-floating-layer="true"]',
].join(",");

export const composerFloatingLayerProps = {
  "data-chat-composer-floating-layer": "true",
} as const;

export function useComposerMenuProps() {
  const composerRef = useComposerHandleContext();

  return {
    ...composerFloatingLayerProps,
    finalFocus: composerRef
      ? () => {
          const activeElement = document.activeElement;
          if (activeElement !== document.body && !isInsideComposerFloatingLayer(activeElement)) {
            return false;
          }
          composerRef.current?.focusAtEnd();
          return false;
        }
      : undefined,
  };
}

export function isInsideComposerFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

// Banners, the approval row, and the tasks badge dock above the surface. A
// pointer or focus landing on one of them acts on that control and must not
// expand a resting or collapsed composer.
export function isInsideCollapsedComposerControls(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-chat-composer-collapsed-controls="true"]') !== null
  );
}

export function isInsideRestingComposerControlScope(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    (target.closest('[data-chat-composer-resting-controls="true"]') !== null ||
      target.closest('[data-chat-composer-resting-images="true"]') !== null ||
      target.closest("[data-composer-context-control]") !== null ||
      isInsideComposerFloatingLayer(target))
  );
}

// An embedded chat, such as the dock's, marks its root as a focus scope.
// Window-level shortcuts act on an embedded chat only while the event comes
// from inside its scope, and the main chat leaves those events to it.
export const focusScopedComposerProps = {
  "data-chat-composer-focus-scope": "true",
} as const;

const FOCUS_SCOPED_COMPOSER_SELECTOR = '[data-chat-composer-focus-scope="true"]';

export function isInsideFocusScopedComposer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(FOCUS_SCOPED_COMPOSER_SELECTOR) !== null;
}

// The focus scope the user last pressed in. Clicking message text leaves DOM
// focus on the body, so keys and pastes that land there belong to the chat the
// user was last working in rather than always to the main one.
let lastPressedFocusScope: Element | null = null;

/** Records the chat a pointer press lands in; composer menus keep the previous one. */
export function noteFocusScopePointerDown(target: EventTarget | null): void {
  if (isInsideComposerFloatingLayer(target)) return;
  lastPressedFocusScope =
    target instanceof Element ? target.closest(FOCUS_SCOPED_COMPOSER_SELECTOR) : null;
}

function isDocumentLevelTarget(target: EventTarget | null): boolean {
  return (
    target === null ||
    (typeof document !== "undefined" &&
      (target === document || target === document.body || target === document.documentElement))
  );
}

/**
 * The focus scope an event belongs to, or null for the main chat. Events from
 * the document body follow the scope the user last pressed in.
 */
export function resolveFocusScope(target: EventTarget | null): Element | null {
  if (isDocumentLevelTarget(target)) {
    return lastPressedFocusScope?.isConnected ? lastPressedFocusScope : null;
  }
  return target instanceof Element ? target.closest(FOCUS_SCOPED_COMPOSER_SELECTOR) : null;
}

/**
 * Whether the chat rooted at or containing `element` owns a window-level
 * shortcut. A focus-scoped chat owns only events from inside its scope; the
 * main chat owns every other event.
 */
export function composerOwnsShortcutEvent(
  element: Element | null,
  target: EventTarget | null,
): boolean {
  const scope = element?.closest(FOCUS_SCOPED_COMPOSER_SELECTOR) ?? null;
  return resolveFocusScope(target) === scope;
}

/**
 * Commands that act on one chat: the main chat leaves them to a focused
 * focus-scoped chat, and that chat answers only these.
 */
export const FOCUS_SCOPED_COMPOSER_COMMANDS: ReadonlySet<string> = new Set([
  "modelPicker.toggle",
  "composer.host",
  "composer.effort",
  "composer.mode",
  "composer.workspace",
  // An embedded chat has no branch toolbar; it swallows these so they never
  // reach the main thread's branch picker.
  "composer.branch",
  "composer.previousWorktree",
  "thread.stop",
  "thread.steerQueuedMessage",
  "thread.copyReference",
  "thread.settle",
  "thread.pin",
]);

// Both the main chat column and an embedded chat mark their roots, so each can
// tell when the user moves into the other one.
export const chatRootProps = {
  "data-chat-root": "true",
} as const;

const CHAT_ROOT_SELECTOR = '[data-chat-root="true"]';

/** Whether a pointer press on `target` lands in a chat other than the one rooted at `ownRoot`. */
export function isInsideOtherChat(ownRoot: Element | null, target: EventTarget | null): boolean {
  if (ownRoot === null || !(target instanceof Element)) return false;
  const root = target.closest(CHAT_ROOT_SELECTOR);
  return root !== null && root !== ownRoot;
}
