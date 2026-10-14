/**
 * Which right-panel surfaces cannot be closed. Pure, so the right panel store
 * can read it without importing any component.
 *
 * @module firstmateSurface
 */

/**
 * The Tasks tab used to be pinned and opened itself on every coordinator chat,
 * which forced the right panel open on phones. It is now an ordinary tab the
 * user opens from the panel's add menu and closes like any other, so nothing
 * is pinned. The hook stays so the store keeps one place to ask.
 */
export function isPinnedRightPanelSurface(_surface: { readonly kind: string }): boolean {
  return false;
}
