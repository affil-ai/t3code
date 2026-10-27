import type { FirstmateColumnId } from "@t3tools/client-runtime/firstmate/board";
import { View } from "react-native";

import { COLUMN_DOT_CLASS } from "./workStatus";

/** The small colored dot that marks a board section or a task's section. */
export function TaskStatusDot(props: {
  readonly column: FirstmateColumnId;
  readonly size?: number;
}) {
  const size = props.size ?? 6;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={COLUMN_DOT_CLASS[props.column]}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  );
}
