/**
 * Class names for an agent's color, from the project icon palette so agent
 * tiles match project tiles. Written out in full so uniwind sees each class.
 */
import type { ProjectIconColor } from "@t3tools/contracts";

import { projectIconColorClassNames } from "../../lib/projectIcon";

const AGENT_TINT_CLASSES: Record<ProjectIconColor, string> = {
  gray: "accent-gray-500",
  red: "accent-red-500",
  orange: "accent-orange-500",
  amber: "accent-amber-500",
  yellow: "accent-yellow-500",
  lime: "accent-lime-500",
  green: "accent-green-500",
  emerald: "accent-emerald-500",
  teal: "accent-teal-500",
  cyan: "accent-cyan-500",
  sky: "accent-sky-500",
  blue: "accent-blue-500",
  indigo: "accent-indigo-500",
  violet: "accent-violet-500",
  purple: "accent-purple-500",
  fuchsia: "accent-fuchsia-500",
  pink: "accent-pink-500",
  rose: "accent-rose-500",
};

export interface AgentColorClassNames {
  /** The tile behind the icon. */
  readonly background: string;
  /** Text in the agent's color. */
  readonly text: string;
  /** `tintColorClassName` for a symbol in the agent's color. */
  readonly tint: string;
}

export function agentColorClassNames(color: ProjectIconColor): AgentColorClassNames {
  return { ...projectIconColorClassNames(color), tint: AGENT_TINT_CLASSES[color] };
}
