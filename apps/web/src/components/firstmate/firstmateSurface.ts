/**
 * Which right-panel surfaces cannot be closed. Pure, so the right panel store
 * can read it without importing any component.
 *
 * @module firstmateSurface
 */

/**
 * Worker task Details is pinned so every task chat has a stable place for the
 * full Tasks-panel detail view.
 */
export function isPinnedRightPanelSurface(surface: { readonly kind: string }): boolean {
  return surface.kind === "task-details";
}
