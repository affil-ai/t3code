/**
 * The icons a user can pick for an agent. The server stores the key; a key
 * this client does not know, such as one from a newer client, draws as the
 * default compass. Each client maps the keys to its own glyphs.
 *
 * @module firstmate/icons
 */
import { FIRSTMATE_DEFAULT_ICON } from "@t3tools/contracts";

/** Picker order and the label each icon reads as. */
export const FIRSTMATE_ICON_LABELS = {
  compass: "Compass",
  "ship-wheel": "Ship wheel",
  anchor: "Anchor",
  sparkles: "Sparkles",
  bot: "Bot",
  rocket: "Rocket",
  star: "Star",
  zap: "Lightning",
  brain: "Brain",
  heart: "Heart",
  flag: "Flag",
  crown: "Crown",
  "dollar-sign": "Dollar sign",
  wallet: "Wallet",
  "chart-no-axes-combined": "Growth chart",
  "briefcase-business": "Business",
  code: "Code",
  search: "Search",
  "book-open": "Book",
  "graduation-cap": "Learning",
  palette: "Palette",
  camera: "Camera",
  "shield-check": "Shield",
  globe: "Globe",
} as const;

export type FirstmateIconKey = keyof typeof FIRSTMATE_ICON_LABELS;

export const FIRSTMATE_ICON_KEYS = Object.keys(FIRSTMATE_ICON_LABELS) as FirstmateIconKey[];

function isFirstmateIconKey(value: string): value is FirstmateIconKey {
  return Object.prototype.hasOwnProperty.call(FIRSTMATE_ICON_LABELS, value);
}

/** The stored key when this client knows it, otherwise the default compass. */
export function resolveFirstmateIconKey(value: string | null | undefined): FirstmateIconKey {
  if (value != null && isFirstmateIconKey(value)) return value;
  return FIRSTMATE_DEFAULT_ICON as FirstmateIconKey;
}
