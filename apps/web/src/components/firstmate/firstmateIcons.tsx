/**
 * The icons a user can pick for Firstmate. The server stores the key; a key
 * this client does not know, such as one from a newer client, draws as the
 * default compass.
 */
import { FIRSTMATE_DEFAULT_ICON } from "@t3tools/contracts";
import {
  AnchorIcon,
  BotIcon,
  BrainIcon,
  CompassIcon,
  CrownIcon,
  DollarSignIcon,
  WalletIcon,
  ChartNoAxesCombinedIcon,
  BriefcaseBusinessIcon,
  CodeIcon,
  SearchIcon,
  BookOpenIcon,
  GraduationCapIcon,
  PaletteIcon,
  CameraIcon,
  ShieldCheckIcon,
  GlobeIcon,
  FlagIcon,
  HeartIcon,
  type LucideIcon,
  RocketIcon,
  ShipWheelIcon,
  SparklesIcon,
  StarIcon,
  ZapIcon,
} from "lucide-react";

export const FIRSTMATE_ICONS = {
  compass: { label: "Compass", Icon: CompassIcon },
  "ship-wheel": { label: "Ship wheel", Icon: ShipWheelIcon },
  anchor: { label: "Anchor", Icon: AnchorIcon },
  sparkles: { label: "Sparkles", Icon: SparklesIcon },
  bot: { label: "Bot", Icon: BotIcon },
  rocket: { label: "Rocket", Icon: RocketIcon },
  star: { label: "Star", Icon: StarIcon },
  zap: { label: "Lightning", Icon: ZapIcon },
  brain: { label: "Brain", Icon: BrainIcon },
  heart: { label: "Heart", Icon: HeartIcon },
  flag: { label: "Flag", Icon: FlagIcon },
  crown: { label: "Crown", Icon: CrownIcon },
  "dollar-sign": { label: "Dollar sign", Icon: DollarSignIcon },
  wallet: { label: "Wallet", Icon: WalletIcon },
  "chart-no-axes-combined": { label: "Growth chart", Icon: ChartNoAxesCombinedIcon },
  "briefcase-business": { label: "Business", Icon: BriefcaseBusinessIcon },
  code: { label: "Code", Icon: CodeIcon },
  search: { label: "Search", Icon: SearchIcon },
  "book-open": { label: "Book", Icon: BookOpenIcon },
  "graduation-cap": { label: "Learning", Icon: GraduationCapIcon },
  palette: { label: "Palette", Icon: PaletteIcon },
  camera: { label: "Camera", Icon: CameraIcon },
  "shield-check": { label: "Shield", Icon: ShieldCheckIcon },
  globe: { label: "Globe", Icon: GlobeIcon },
} as const satisfies Record<string, { readonly label: string; readonly Icon: LucideIcon }>;

export type FirstmateIconKey = keyof typeof FIRSTMATE_ICONS;

export const FIRSTMATE_ICON_KEYS = Object.keys(FIRSTMATE_ICONS) as FirstmateIconKey[];

function isFirstmateIconKey(value: string): value is FirstmateIconKey {
  return Object.hasOwn(FIRSTMATE_ICONS, value);
}

/** The stored key when this client knows it, otherwise the default compass. */
export function resolveFirstmateIconKey(value: string | null | undefined): FirstmateIconKey {
  if (value != null && isFirstmateIconKey(value)) return value;
  return FIRSTMATE_DEFAULT_ICON as FirstmateIconKey;
}

export function FirstmateIcon({
  icon,
  className,
}: {
  readonly icon: string | null | undefined;
  readonly className?: string;
}) {
  const { Icon } = FIRSTMATE_ICONS[resolveFirstmateIconKey(icon)];
  return <Icon className={className} aria-hidden />;
}
