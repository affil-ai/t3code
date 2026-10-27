/**
 * The SF Symbol each agent icon key draws as on iOS. Keys and the
 * unknown-key fallback come from client-runtime; Android draws the matching
 * Tabler glyphs in `AgentIconGlyph.tsx`.
 */
import {
  type FirstmateIconKey,
  resolveFirstmateIconKey,
} from "@t3tools/client-runtime/firstmate/icons";
import type { SFSymbol } from "expo-symbols";

/** Props shared by the iOS and Android `AgentIconGlyph`. */
export interface AgentIconGlyphProps {
  readonly icon: string | null | undefined;
  readonly size: number;
  /** A uniwind `accent-*` class for the glyph color. */
  readonly tintColorClassName?: string;
}

export const AGENT_ICON_SF_SYMBOLS: Record<FirstmateIconKey, SFSymbol> = {
  compass: "safari",
  "ship-wheel": "helm",
  anchor: "ferry",
  sparkles: "sparkles",
  bot: "cpu",
  rocket: "airplane.departure",
  star: "star",
  zap: "bolt",
  brain: "brain",
  heart: "heart",
  flag: "flag",
  crown: "crown",
  "dollar-sign": "dollarsign",
  wallet: "wallet.bifold",
  "chart-no-axes-combined": "chart.line.uptrend.xyaxis",
  "briefcase-business": "briefcase",
  code: "chevron.left.forwardslash.chevron.right",
  search: "magnifyingglass",
  "book-open": "book",
  "graduation-cap": "graduationcap",
  palette: "paintpalette",
  camera: "camera",
  "shield-check": "checkmark.shield",
  globe: "globe",
};

/** The SF Symbol for a stored icon key; unknown keys draw as the compass. */
export function agentIconSymbol(icon: string | null | undefined): SFSymbol {
  return AGENT_ICON_SF_SYMBOLS[resolveFirstmateIconKey(icon)];
}
