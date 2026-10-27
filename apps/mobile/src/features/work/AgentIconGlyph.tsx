import type { Icon } from "@tabler/icons-react-native/types";
/*
 * Per-icon imports, as in AppSymbol: the package root registers every Tabler
 * icon in Metro.
 */
import IconAnchor from "@tabler/icons-react-native/IconAnchor";
import IconBook from "@tabler/icons-react-native/IconBook";
import IconBolt from "@tabler/icons-react-native/IconBolt";
import IconBrain from "@tabler/icons-react-native/IconBrain";
import IconBriefcase from "@tabler/icons-react-native/IconBriefcase";
import IconCamera from "@tabler/icons-react-native/IconCamera";
import IconChartLine from "@tabler/icons-react-native/IconChartLine";
import IconCode from "@tabler/icons-react-native/IconCode";
import IconCompass from "@tabler/icons-react-native/IconCompass";
import IconCrown from "@tabler/icons-react-native/IconCrown";
import IconCurrencyDollar from "@tabler/icons-react-native/IconCurrencyDollar";
import IconFlag from "@tabler/icons-react-native/IconFlag";
import IconHeart from "@tabler/icons-react-native/IconHeart";
import IconPalette from "@tabler/icons-react-native/IconPalette";
import IconRobot from "@tabler/icons-react-native/IconRobot";
import IconRocket from "@tabler/icons-react-native/IconRocket";
import IconSchool from "@tabler/icons-react-native/IconSchool";
import IconSearch from "@tabler/icons-react-native/IconSearch";
import IconShieldCheck from "@tabler/icons-react-native/IconShieldCheck";
import IconSparkles from "@tabler/icons-react-native/IconSparkles";
import IconStar from "@tabler/icons-react-native/IconStar";
import IconSteeringWheel from "@tabler/icons-react-native/IconSteeringWheel";
import IconWallet from "@tabler/icons-react-native/IconWallet";
import IconWorld from "@tabler/icons-react-native/IconWorld";
import {
  type FirstmateIconKey,
  resolveFirstmateIconKey,
} from "@t3tools/client-runtime/firstmate/icons";
import { withUniwind } from "uniwind";

const AGENT_ICON_GLYPHS: Record<FirstmateIconKey, Icon> = {
  compass: IconCompass,
  "ship-wheel": IconSteeringWheel,
  anchor: IconAnchor,
  sparkles: IconSparkles,
  bot: IconRobot,
  rocket: IconRocket,
  star: IconStar,
  zap: IconBolt,
  brain: IconBrain,
  heart: IconHeart,
  flag: IconFlag,
  crown: IconCrown,
  "dollar-sign": IconCurrencyDollar,
  wallet: IconWallet,
  "chart-no-axes-combined": IconChartLine,
  "briefcase-business": IconBriefcase,
  code: IconCode,
  search: IconSearch,
  "book-open": IconBook,
  "graduation-cap": IconSchool,
  palette: IconPalette,
  camera: IconCamera,
  "shield-check": IconShieldCheck,
  globe: IconWorld,
};

function AgentIconGlyphView(props: {
  readonly icon: string | null | undefined;
  readonly size: number;
  readonly tintColor?: string;
}) {
  const Glyph = AGENT_ICON_GLYPHS[resolveFirstmateIconKey(props.icon)];
  return <Glyph color={props.tintColor} size={props.size} strokeWidth={2} />;
}

/** An agent's icon as its Tabler glyph, matching web's lucide icons. */
export const AgentIconGlyph = withUniwind(AgentIconGlyphView);
