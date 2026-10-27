import { SymbolView } from "../../components/ui/AppSymbol";
import { type AgentIconGlyphProps, agentIconSymbol } from "./agentIcons";

/** An agent's icon as its SF Symbol. */
export function AgentIconGlyph(props: AgentIconGlyphProps) {
  return (
    <SymbolView
      name={{ ios: agentIconSymbol(props.icon), android: "auto_awesome" }}
      size={props.size}
      {...(props.tintColorClassName === undefined
        ? {}
        : { tintColorClassName: props.tintColorClassName })}
    />
  );
}
