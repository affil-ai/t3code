import {
  FIRSTMATE_ICON_KEYS,
  FIRSTMATE_ICON_LABELS,
  type FirstmateIconKey,
} from "@t3tools/client-runtime/firstmate/icons";
import type { ProjectIconColor } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { cn } from "../../lib/cn";
import { AGENT_EDITOR_COLORS } from "./agent-editor.logic";
import { agentColorClassNames } from "./agentColors";
import { AgentIconGlyph } from "./AgentIconGlyph";

/** Solid swatches, written out in full so uniwind sees each class. */
const SWATCH_CLASSES: Record<ProjectIconColor, string> = {
  gray: "bg-gray-500",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  yellow: "bg-yellow-500",
  lime: "bg-lime-500",
  green: "bg-green-500",
  emerald: "bg-emerald-500",
  teal: "bg-teal-500",
  cyan: "bg-cyan-500",
  sky: "bg-sky-500",
  blue: "bg-blue-500",
  indigo: "bg-indigo-500",
  violet: "bg-violet-500",
  purple: "bg-purple-500",
  fuchsia: "bg-fuchsia-500",
  pink: "bg-pink-500",
  rose: "bg-rose-500",
};

/** The shared agent icon set as a grid; the picked icon sits on the agent's color. */
export function AgentEditorIconGrid(props: {
  readonly value: FirstmateIconKey;
  readonly color: ProjectIconColor;
  readonly disabled: boolean;
  readonly onChange: (icon: FirstmateIconKey) => void;
}) {
  const colors = agentColorClassNames(props.color);
  return (
    <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
      {FIRSTMATE_ICON_KEYS.map((key) => {
        const selected = key === props.value;
        return (
          <Pressable
            key={key}
            accessibilityRole="radio"
            accessibilityLabel={FIRSTMATE_ICON_LABELS[key]}
            accessibilityState={{ selected, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onChange(key)}
            className={cn(
              "size-11 items-center justify-center rounded-xl active:opacity-70",
              selected ? colors.background : "bg-subtle",
            )}
          >
            <AgentIconGlyph
              icon={key}
              size={22}
              tintColorClassName={selected ? colors.tint : "accent-foreground-muted"}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/** The project icon palette as round swatches; the picked one is ringed. */
export function AgentEditorColorPicker(props: {
  readonly value: ProjectIconColor;
  readonly disabled: boolean;
  readonly onChange: (color: ProjectIconColor) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-1.5">
      {AGENT_EDITOR_COLORS.map((option) => {
        const selected = option.value === props.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected, disabled: props.disabled }}
            disabled={props.disabled}
            onPress={() => props.onChange(option.value)}
            className={cn(
              "size-9 items-center justify-center rounded-full border-2 active:opacity-70",
              selected ? "border-foreground-muted" : "border-transparent",
            )}
          >
            <View className={cn("size-6 rounded-full", SWATCH_CLASSES[option.value])} />
          </Pressable>
        );
      })}
    </View>
  );
}
