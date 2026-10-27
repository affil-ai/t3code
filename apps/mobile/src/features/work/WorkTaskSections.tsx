/**
 * The read-only parts of the Work task detail, in web's order: progress,
 * next step, evidence, done criteria, artifacts and links, the request, and
 * the activity history.
 */
import {
  doneCriteria,
  EVENT_ACTOR_LABELS,
  mergedPullRequestLabel,
  readableTaskEvents,
} from "@t3tools/client-runtime/firstmate/tasks";
import { firstmateProgressView } from "@t3tools/client-runtime/firstmate/progress";
import type {
  AssetResource,
  EnvironmentId,
  FirstmateTask,
  FirstmateTaskArtifact,
  FirstmateTaskId,
  ThreadId,
} from "@t3tools/contracts";
import { Image } from "expo-image";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Polyline } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import { AppText } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { RowPressable } from "../../components/ui/RowPressable";
import { assetImageSource } from "../../lib/assetImageSource";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTime } from "../../lib/time";
import { useNavigateToPullRequest } from "../../native/useOpenPullRequest";
import { useAssetUrlState } from "../../state/assets";
import { useFirstmateTask } from "../../state/firstmate";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  WORK_TASK_SPARK_HEIGHT,
  WORK_TASK_SPARK_WIDTH,
  workTaskLinkKind,
  workTaskProgressDisplay,
  type WorkTaskNextStep,
} from "./WorkTaskModel";
import { useWorkTaskPullRequest } from "./WorkTaskState";

const CRITERIA_PREVIEW = 5;
const HISTORY_PREVIEW = 3;
const REQUEST_PREVIEW_LINES = 6;

export function WorkTaskSection(props: {
  readonly title: string;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-baseline justify-between gap-2">
        <AppText
          accessibilityRole="header"
          textRole="caption"
          className="font-t3-semibold tracking-wide text-foreground-muted uppercase"
        >
          {props.title}
        </AppText>
        {props.trailing}
      </View>
      {props.children}
    </View>
  );
}

/** Toggles a list between its first few rows and all of them. */
function ShowAllToggle(props: {
  readonly total: number;
  readonly preview: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  if (props.total <= props.preview) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: props.expanded }}
      hitSlop={8}
      onPress={props.onToggle}
    >
      <AppText textRole="label" className="text-foreground-muted">
        {props.expanded ? "Show less" : `Show all ${props.total}`}
      </AppText>
    </Pressable>
  );
}

/** The worker-reported progress line: a sparkline for a metric, a bar for a count. */
export function WorkTaskProgress(props: { readonly task: FirstmateTask }) {
  const display = workTaskProgressDisplay(firstmateProgressView(props.task));
  const stroke = StyleSheet.flatten(useResolveClassNames("text-foreground-muted"))?.color;
  if (display === null) return null;
  return (
    <View className="flex-row items-center gap-2">
      <AppText
        textRole="label"
        numberOfLines={2}
        className={cn("min-w-0 shrink text-foreground-muted", display.provisional && "italic")}
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {display.text}
      </AppText>
      {display.sparkline !== null ? (
        <Svg
          accessible={false}
          width={WORK_TASK_SPARK_WIDTH}
          height={WORK_TASK_SPARK_HEIGHT}
          viewBox={`0 0 ${WORK_TASK_SPARK_WIDTH} ${WORK_TASK_SPARK_HEIGHT}`}
          style={{ overflow: "visible" }}
        >
          <Polyline
            points={display.sparkline}
            fill="none"
            stroke={typeof stroke === "string" ? stroke : "gray"}
            strokeOpacity={0.8}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      ) : null}
      {display.fraction !== null ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="h-1 w-14 overflow-hidden rounded-full bg-subtle-strong"
        >
          <View
            className="h-full rounded-full bg-foreground-muted"
            style={{ width: `${display.fraction * 100}%` }}
          />
        </View>
      ) : null}
    </View>
  );
}

/** What happens next; when it is on the user, the card stands out. */
export function WorkTaskNextStepCard(props: {
  readonly nextStep: WorkTaskNextStep;
  readonly children?: ReactNode;
}) {
  const { onUser, eyebrow, text } = props.nextStep;
  return (
    <View
      className={cn(
        "gap-1 rounded-2xl border px-4 py-3",
        onUser ? "border-warning-border bg-warning" : "border-border-subtle bg-subtle",
      )}
    >
      <AppText
        textRole="caption"
        className={cn(
          "font-t3-semibold tracking-wide uppercase",
          onUser ? "text-warning-foreground" : "text-foreground-muted",
        )}
      >
        {eyebrow}
      </AppText>
      <AppText selectable textRole="body" className="font-t3-medium">
        {text}
      </AppText>
      {props.children}
    </View>
  );
}

export function WorkTaskText(props: { readonly children: string }) {
  return (
    <AppText selectable textRole="footnote" className="leading-5">
      {props.children}
    </AppText>
  );
}

export function WorkTaskDoneCriteria(props: { readonly text: string }) {
  const criteria = doneCriteria(props.text);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? criteria : criteria.slice(0, CRITERIA_PREVIEW);
  return (
    <WorkTaskSection
      title="Done when"
      trailing={
        <ShowAllToggle
          total={criteria.length}
          preview={CRITERIA_PREVIEW}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      }
    >
      <View className="gap-1.5">
        {shown.map((criterion, index) => (
          // Criteria are static text that can repeat; their position is their identity.
          // oxlint-disable-next-line react/no-array-index-key
          <View key={`${index}:${criterion}`} className="flex-row gap-2.5">
            <View className="mt-[7px] size-1.5 rounded-full border border-foreground-muted" />
            <AppText selectable textRole="footnote" className="min-w-0 flex-1 leading-5">
              {criterion}
            </AppText>
          </View>
        ))}
      </View>
    </WorkTaskSection>
  );
}

/** The user's original request, clamped until expanded. */
export function WorkTaskRequest(props: { readonly intent: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  return (
    <WorkTaskSection title="Request">
      <View className="gap-1.5 border-l-2 border-border pl-3">
        <AppText
          selectable
          textRole="footnote"
          className="leading-5 text-foreground-muted"
          numberOfLines={expanded ? undefined : REQUEST_PREVIEW_LINES}
          onTextLayout={(event) => {
            if (!expanded) setClamped(event.nativeEvent.lines.length >= REQUEST_PREVIEW_LINES);
          }}
        >
          {props.intent}
        </AppText>
        {clamped ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => setExpanded((value) => !value)}
          >
            <AppText textRole="label" className="font-t3-medium text-foreground">
              {expanded ? "Show less" : "Show full request"}
            </AppText>
          </Pressable>
        ) : null}
      </View>
    </WorkTaskSection>
  );
}

function LinkRow(props: {
  readonly icon: AppSymbolName;
  readonly iconTintClassName?: string;
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly onPress: () => void;
}) {
  return (
    <RowPressable
      accessibilityRole="link"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      onPress={props.onPress}
      className="min-h-11 flex-row items-center gap-2.5 rounded-xl border border-border-subtle px-3 py-2.5"
    >
      <SymbolView
        name={props.icon}
        size={16}
        tintColorClassName={props.iconTintClassName ?? "accent-icon-muted"}
      />
      <AppText textRole="footnote" numberOfLines={1} className="min-w-0 flex-1">
        {props.label}
      </AppText>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
    </RowPressable>
  );
}

function openWebLink(url: string) {
  void tryOpenExternalUrl(url, "markdown-link");
}

/**
 * A pull request link draws its live state, as the sidebar does, and opens
 * the app's pull request screen when a project here holds the repository.
 * A closed one is hidden, as on web.
 */
function PullRequestLinkRow(props: {
  readonly environmentId: EnvironmentId;
  readonly link: FirstmateTask["links"][number];
}) {
  const { projectId, summary } = useWorkTaskPullRequest(props.environmentId, props.link.url);
  const navigateToPullRequest = useNavigateToPullRequest();
  if (summary?.state === "closed") return null;
  const merged = summary?.state === "merged";
  const draft = !merged && summary?.isDraft === true;
  return (
    <LinkRow
      icon={
        merged
          ? PullRequestGlyph.merged
          : draft
            ? PullRequestGlyph.draft
            : PullRequestGlyph.pullRequest
      }
      iconTintClassName={
        merged
          ? "accent-adaptive-violet-600-400"
          : summary?.state === "open" && !draft
            ? "accent-adaptive-emerald-600-400"
            : undefined
      }
      label={merged ? mergedPullRequestLabel(props.link.label) : props.link.label}
      accessibilityLabel={
        summary
          ? `${props.link.label}, pull request ${merged ? "merged" : draft ? "draft" : "open"}`
          : props.link.label
      }
      onPress={() =>
        void navigateToPullRequest(
          props.link.url,
          projectId === null ? null : { environmentId: props.environmentId, projectId },
        )
      }
    />
  );
}

/** The worker chat, then each external link with an icon for what it points at. */
export function WorkTaskLinks(props: {
  readonly environmentId: EnvironmentId;
  readonly task: FirstmateTask;
  readonly onOpenWorker: (threadId: ThreadId) => void;
}) {
  const workerThreadId = props.task.workerThreadId;
  return (
    <View className="gap-2">
      {workerThreadId !== null ? (
        <LinkRow
          icon="text.bubble"
          label="Worker chat"
          onPress={() => props.onOpenWorker(workerThreadId)}
        />
      ) : null}
      {props.task.links.map((link) => {
        const kind = workTaskLinkKind(link.url);
        return kind === "pull-request" ? (
          <PullRequestLinkRow
            key={`${link.label}:${link.url}`}
            environmentId={props.environmentId}
            link={link}
          />
        ) : (
          <LinkRow
            key={`${link.label}:${link.url}`}
            icon={kind === "slack" ? "bubble.left.and.bubble.right" : "link"}
            label={link.label}
            onPress={() => openWebLink(link.url)}
          />
        );
      })}
    </View>
  );
}

/** A screenshot artifact, signed against the coordinator chat; a tap opens the viewer. */
function ArtifactImage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly artifact: FirstmateTaskArtifact;
  readonly onOpen: (source: FilePreviewSource) => void;
}) {
  const resource: AssetResource = {
    _tag: "media-file",
    threadId: props.threadId,
    path: props.artifact.url,
  };
  const asset = useAssetUrlState(props.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const frame = "aspect-video w-full overflow-hidden rounded-xl border border-border-subtle";
  if (asset._tag === "Loading") return <View className={cn(frame, "bg-subtle")} />;
  if (asset._tag !== "Success" || asset.url === failedUrl) {
    return (
      <View className={cn(frame, "flex-row items-center justify-center gap-1.5 bg-subtle")}>
        <SymbolView name="photo" size={14} tintColorClassName="accent-icon-muted" />
        <AppText textRole="label" className="text-foreground-muted">
          Image unavailable
        </AppText>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`View ${props.artifact.label}`}
      className={frame}
      onPress={() =>
        props.onOpen({
          kind: "image",
          name: props.artifact.label,
          environmentId: props.environmentId,
          resource,
        })
      }
    >
      <Image
        source={assetImageSource(props.environmentId, resource, asset.url)}
        style={{ width: "100%", height: "100%" }}
        contentFit="cover"
        contentPosition="top"
        onError={() => setFailedUrl(asset.url)}
      />
    </Pressable>
  );
}

/**
 * The links and screenshots the coordinator attached for review. Images are
 * files on the server signed against the coordinator chat, so they need it.
 */
export function WorkTaskArtifacts(props: {
  readonly environmentId: EnvironmentId;
  readonly coordinatorThreadId: ThreadId | null;
  readonly artifacts: ReadonlyArray<FirstmateTaskArtifact>;
}) {
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const coordinatorThreadId = props.coordinatorThreadId;
  const shown = props.artifacts.filter(
    (artifact) => artifact.kind !== "image" || coordinatorThreadId !== null,
  );
  if (shown.length === 0) return null;
  return (
    <View className="gap-3">
      {shown.map((artifact) => (
        <View key={`${artifact.label}:${artifact.url}`} className="gap-1.5">
          {artifact.kind === "image" && coordinatorThreadId !== null ? (
            <>
              <AppText textRole="footnote" className="font-t3-medium">
                {artifact.label}
              </AppText>
              <ArtifactImage
                environmentId={props.environmentId}
                threadId={coordinatorThreadId}
                artifact={artifact}
                onOpen={setPreview}
              />
            </>
          ) : (
            <LinkRow
              icon="arrow.up.right"
              label={artifact.label}
              onPress={() => openWebLink(artifact.url)}
            />
          )}
          {artifact.caption?.trim() ? (
            <AppText textRole="label" className="text-foreground-muted">
              {artifact.caption}
            </AppText>
          ) : null}
        </View>
      ))}
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </View>
  );
}

/**
 * The task's history, newest first. The server only resolves Firstmate's
 * tasks here, so the caller leaves it out for custom agents; a failure hides
 * the section rather than showing an error for a view that cannot load.
 */
export function WorkTaskHistory(props: {
  readonly environmentId: EnvironmentId;
  readonly taskId: FirstmateTaskId;
}) {
  const detail = useFirstmateTask(props.environmentId, props.taskId);
  const [expanded, setExpanded] = useState(false);
  const events = detail.data ? readableTaskEvents(detail.data.events) : null;
  if (events === null && detail.error !== null) return null;
  const shown = events === null ? null : expanded ? events : events.slice(0, HISTORY_PREVIEW);
  return (
    <WorkTaskSection
      title="Activity"
      trailing={
        events === null ? null : (
          <ShowAllToggle
            total={events.length}
            preview={HISTORY_PREVIEW}
            expanded={expanded}
            onToggle={() => setExpanded((value) => !value)}
          />
        )
      }
    >
      {shown === null ? (
        <View className="gap-2" accessibilityState={{ busy: true }}>
          <View className="h-4 w-3/4 rounded bg-subtle" />
          <View className="h-4 w-1/2 rounded bg-subtle" />
        </View>
      ) : shown.length === 0 ? (
        <AppText textRole="footnote" className="text-foreground-muted">
          No history yet.
        </AppText>
      ) : (
        <View className="gap-2">
          {shown.map((event) => (
            <View key={event.id} className="flex-row gap-3">
              <AppText
                textRole="label"
                className="w-10 text-right text-foreground-muted"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {relativeTime(event.createdAt)}
              </AppText>
              <AppText selectable textRole="label" className="min-w-0 flex-1">
                {event.actor === "coordinator" ? null : (
                  <AppText textRole="label" className="text-foreground-muted">
                    {EVENT_ACTOR_LABELS[event.actor]}:{" "}
                  </AppText>
                )}
                {event.summary}
              </AppText>
            </View>
          ))}
        </View>
      )}
    </WorkTaskSection>
  );
}
