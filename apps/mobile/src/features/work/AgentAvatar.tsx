import type { EnvironmentId, ProjectIconColor } from "@t3tools/contracts";
import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";

import { assetImageSource } from "../../lib/assetImageSource";
import { useAssetUrlState } from "../../state/assets";
import { agentColorClassNames } from "./agentColors";
import { AgentIconGlyph } from "./AgentIconGlyph";

/**
 * An agent's icon on a tile in its color, or its avatar image once that
 * loads, as on web. Pass `environmentId` and `avatarAttachmentId` to try the
 * image; the icon stays up while it loads or if it fails.
 */
export function AgentAvatar(props: {
  readonly icon: string;
  readonly color: ProjectIconColor;
  /** Tile width and height. Defaults to 36, the sidebar row's size. */
  readonly size?: number;
  readonly environmentId?: EnvironmentId | undefined;
  readonly avatarAttachmentId?: string | undefined;
}) {
  const size = props.size ?? 36;
  const colors = agentColorClassNames(props.color);
  const glyph = (
    <AgentIconGlyph
      icon={props.icon}
      size={Math.round(size * 0.55)}
      tintColorClassName={colors.tint}
    />
  );
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={colors.background}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {props.environmentId !== undefined && props.avatarAttachmentId !== undefined ? (
        <AgentAvatarImage
          key={`${props.environmentId}:${props.avatarAttachmentId}`}
          environmentId={props.environmentId}
          attachmentId={props.avatarAttachmentId}
          size={size}
          fallback={glyph}
        />
      ) : (
        glyph
      )}
    </View>
  );
}

function AgentAvatarImage(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly size: number;
  readonly fallback: React.ReactNode;
}) {
  const resource = { _tag: "attachment" as const, attachmentId: props.attachmentId };
  const asset = useAssetUrlState(props.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (asset._tag !== "Success" || asset.url === failedUrl) return props.fallback;
  return (
    <Image
      source={assetImageSource(props.environmentId, resource, asset.url)}
      style={{ width: props.size, height: props.size }}
      contentFit="cover"
      onError={() => setFailedUrl(asset.url)}
    />
  );
}
