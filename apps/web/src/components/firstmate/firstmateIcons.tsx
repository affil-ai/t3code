/**
 * The lucide glyph for each agent icon key. The keys, labels, and the
 * unknown-key fallback live in `@t3tools/client-runtime/firstmate/icons`,
 * shared with mobile.
 */
import {
  FIRSTMATE_ICON_LABELS,
  type FirstmateIconKey,
  resolveFirstmateIconKey,
} from "@t3tools/client-runtime/firstmate/icons";
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
  compass: { label: FIRSTMATE_ICON_LABELS.compass, Icon: CompassIcon },
  "ship-wheel": { label: FIRSTMATE_ICON_LABELS["ship-wheel"], Icon: ShipWheelIcon },
  anchor: { label: FIRSTMATE_ICON_LABELS.anchor, Icon: AnchorIcon },
  sparkles: { label: FIRSTMATE_ICON_LABELS.sparkles, Icon: SparklesIcon },
  bot: { label: FIRSTMATE_ICON_LABELS.bot, Icon: BotIcon },
  rocket: { label: FIRSTMATE_ICON_LABELS.rocket, Icon: RocketIcon },
  star: { label: FIRSTMATE_ICON_LABELS.star, Icon: StarIcon },
  zap: { label: FIRSTMATE_ICON_LABELS.zap, Icon: ZapIcon },
  brain: { label: FIRSTMATE_ICON_LABELS.brain, Icon: BrainIcon },
  heart: { label: FIRSTMATE_ICON_LABELS.heart, Icon: HeartIcon },
  flag: { label: FIRSTMATE_ICON_LABELS.flag, Icon: FlagIcon },
  crown: { label: FIRSTMATE_ICON_LABELS.crown, Icon: CrownIcon },
  "dollar-sign": { label: FIRSTMATE_ICON_LABELS["dollar-sign"], Icon: DollarSignIcon },
  wallet: { label: FIRSTMATE_ICON_LABELS.wallet, Icon: WalletIcon },
  "chart-no-axes-combined": {
    label: FIRSTMATE_ICON_LABELS["chart-no-axes-combined"],
    Icon: ChartNoAxesCombinedIcon,
  },
  "briefcase-business": {
    label: FIRSTMATE_ICON_LABELS["briefcase-business"],
    Icon: BriefcaseBusinessIcon,
  },
  code: { label: FIRSTMATE_ICON_LABELS.code, Icon: CodeIcon },
  search: { label: FIRSTMATE_ICON_LABELS.search, Icon: SearchIcon },
  "book-open": { label: FIRSTMATE_ICON_LABELS["book-open"], Icon: BookOpenIcon },
  "graduation-cap": { label: FIRSTMATE_ICON_LABELS["graduation-cap"], Icon: GraduationCapIcon },
  palette: { label: FIRSTMATE_ICON_LABELS.palette, Icon: PaletteIcon },
  camera: { label: FIRSTMATE_ICON_LABELS.camera, Icon: CameraIcon },
  "shield-check": { label: FIRSTMATE_ICON_LABELS["shield-check"], Icon: ShieldCheckIcon },
  globe: { label: FIRSTMATE_ICON_LABELS.globe, Icon: GlobeIcon },
} as const satisfies Record<
  FirstmateIconKey,
  { readonly label: string; readonly Icon: LucideIcon }
>;

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
