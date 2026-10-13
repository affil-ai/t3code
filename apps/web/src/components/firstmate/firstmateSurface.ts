/**
 * Which right-panel surfaces cannot be closed. Pure, so the right panel store
 * can read it without importing any component.
 *
 * @module firstmateSurface
 */

/** Firstmate's Tasks tab stays open beside its chat; closing never removes it. */
export function isPinnedRightPanelSurface(surface: { readonly kind: string }): boolean {
  return surface.kind === "firstmate";
}
