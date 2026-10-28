import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import { Spinner } from "~/components/ui/spinner";
import {
  ArchiveIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  Globe2Icon,
  PinIcon,
  PinOffIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  PrStatusTooltipContent,
  terminalStatusFromRunningIds,
  ThreadStatusIcon,
  synchronizeTerminalPulse,
  ThreadTerminalStatusButton,
  ThreadStatusLabel,
  ThreadWorktreeIndicator,
  useLinkedThreadPullRequest,
} from "./ThreadStatusIndicators";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useIsThreadPinned, useWorkPinnedStore } from "../workPinnedStore";
import { ProjectFavicon } from "./ProjectFavicon";
import { useAtomValue } from "@effect/atom-react";
import { autoAnimate } from "@formkit/auto-animate";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  type ContextMenuItem,
  type EnvironmentId,
  ProjectId,
  type ScopedThreadRef,
  type ResolvedKeybindingsConfig,
  type SidebarProjectGroupingMode,
  resolveEnvironmentMachineKind,
  ThreadId,
} from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
  type SidebarProjectSortOrder,
  type SidebarThreadPreviewCount,
  type SidebarThreadSortOrder,
} from "@t3tools/contracts/settings";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "../connection/desktopLocal";
import { useDesktopLocalBootstraps } from "../connection/useDesktopLocalBootstraps";
import { isElectron } from "../env";
import { useTerminalFocus } from "../hooks/useTerminalFocus";
import { useOpenPrLink } from "../lib/openPullRequestLink";
import { releaseProjectDraftUploads } from "../lib/composerDraftUploads";
import { isTerminalFocused } from "../lib/terminalFocus";
import { cn, isMacPlatform, newThreadId } from "../lib/utils";
import { useSidebarPendingFileDropStore } from "../sidebarPendingFileDropStore";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import {
  readThreadShell,
  useProjects,
  useThreadShells,
  useThreadShellsForProjectRefs,
  waitForThreadShell,
  waitForProjectRemoval,
} from "../state/entities";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { useThreadDiscoveredPorts } from "../portDiscoveryState";
import { openDiscoveredPort } from "./preview/openDiscoveredPort";
import { useAtomCommand } from "../state/use-atom-command";
import {
  ORCHESTRATION_OPERATE_DENIED_MESSAGE,
  useOrchestrationCommand,
} from "../state/use-orchestration-command";
import { previewEnvironment } from "../state/preview";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import {
  legacyProjectCwdPreferenceKey,
  resolveProjectExpanded,
  useUiStateStore,
} from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { useShortcutModifierState } from "../shortcutModifierState";
import { ensureLocalApi, readLocalApi } from "../localApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useDesktopUpdateState } from "../state/desktopUpdate";

import { useThreadActions } from "../hooks/useThreadActions";
import { projectEnvironment } from "../state/projects";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { buildThreadRouteParams, resolveActiveThreadRouteRef } from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { RelativeTime } from "./RelativeTime";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "./ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "./ui/sidebar";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { isCommandPaletteOpen, openCommandPalette } from "../commandPaletteBus";
import {
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
  deleteSelectedThreadEntries,
  filterSidebarV2VisibleThreads,
  getSidebarThreadIdsToPrewarm,
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  resolveProjectStatusIndicator,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  useSidebarRowSubscriptionLease,
  setFileDragActive,
  useThreadJumpHintsVisible,
  ThreadStatusPill,
} from "./Sidebar.logic";
import { sortThreads } from "../lib/threadSort";
import { SidebarChromeFooter, SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { useClientSettings, updateClientSettings } from "~/hooks/useSettings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { canShareWithGuestAtom } from "./chat/guestShareAvailability";
import { openGuestShareDialog } from "./chat/guestShareDialogState";
import {
  derivePhysicalProjectKey,
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import type { SidebarThreadSummary } from "../types";
import {
  buildWorkFolderTree,
  useAppMode,
  useWorkModeStore,
  type WorkFolderNode,
} from "../workModeStore";
import {
  applyWorkThreadMenuAction,
  buildWorkThreadMenuItemsForKeys,
  groupWorkThreads,
  isWorkProjectDrag,
  isWorkThreadDrag,
  resolveDropPosition,
  WORK_PROJECT_DRAG_TYPE,
  readWorkThreadDrag,
  writeWorkThreadDrag,
  resolveWorkChatRepositoryKey,
} from "./work/workChats.logic";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { type SidebarRouteReveal, useActiveRowReveal } from "./sidebar/routeReveal";
import { AgentSwitcher, useSelectedAgent } from "./agents/AgentSwitcher"; // fork: agents
import { AgentSidebarSections } from "./agents/AgentSidebarSections"; // fork: agents
import { isFirstmateAgent } from "@t3tools/client-runtime/firstmate/agents"; // fork: agents
import { useCustomAgentWorkerThreadKeys } from "~/state/agents"; // fork: agents
import { Separator } from "./ui/separator"; // fork: agents
import { useFirstmateCoordinatorThreadKeys } from "./firstmate/useFirstmateCoordinatorThreadKeys"; // fork: firstmate
import { readFirstmateHomeProjectKeys } from "./firstmate/firstmateChatLists"; // fork: firstmate
import { workRepositories } from "./work/workRepositories"; // fork: repositories in Work
import {
  readAgentHomeProjectKeys,
  useAgentCoordinatorThreadKeys,
} from "./agents/useAgentThreadKeys"; // fork: agents
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};
const SIDEBAR_ICON_ACTION_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-0.75 text-icon-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";
// Work rows swap the status icon for archive in place, so the button takes the
// status icon's 16px box; the pseudo-element keeps a 24px hit area.
// Work section header actions (New project, New chat) show on hover or focus on
// desktop and stay visible on touch screens, which have no hover.
const WORK_SECTION_HEADER_ACTION_CLASS =
  "opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/section-header:opacity-100 pointer-coarse:opacity-100";
const WORK_ARCHIVE_BUTTON_CLASS =
  "relative inline-flex size-4 cursor-pointer items-center justify-center rounded-sm text-icon-muted before:absolute before:-inset-1 before:content-[''] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

function SidebarThreadDetailPrewarmer({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  return null;
}

function clampSidebarThreadPreviewCount(value: number): SidebarThreadPreviewCount {
  return Math.min(
    MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
    Math.max(MIN_SIDEBAR_THREAD_PREVIEW_COUNT, value),
  ) as SidebarThreadPreviewCount;
}

function formatProjectMemberActionLabel(
  member: SidebarProjectGroupMember,
  groupedProjectCount: number,
): string {
  if (groupedProjectCount <= 1) {
    return member.title;
  }

  return member.environmentLabel
    ? `${member.environmentLabel}: ${member.workspaceRoot}`
    : member.workspaceRoot;
}

function projectExpansionPreferenceKeys(project: SidebarProjectSnapshot): string[] {
  return [
    project.projectKey,
    ...project.memberProjects.map((member) => member.physicalProjectKey),
    ...project.memberProjects.map((member) => legacyProjectCwdPreferenceKey(member.workspaceRoot)),
  ];
}

function projectGroupingModeDescription(mode: SidebarProjectGroupingMode): string {
  switch (mode) {
    case "repository":
      return "Projects from the same repository share one sidebar row.";
    case "repository_path":
      return "Projects group only when both the repository and repo-relative path match.";
    case "separate":
      return "Every project path gets its own sidebar row.";
  }
}

function buildThreadJumpLabelMap(input: {
  keybindings: ResolvedKeybindingsConfig;
  platform: string;
  terminalOpen: boolean;
  threadJumpCommandByKey: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByKey.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {
      terminalFocus: false,
      terminalOpen: input.terminalOpen,
    },
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadKey, command] of input.threadJumpCommandByKey) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

interface SidebarThreadRowProps {
  thread: SidebarThreadSummary;
  orderedProjectThreadKeys: readonly string[];
  isActive: boolean;
  openPullRequestsInRightPanel: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  startThreadRename: (threadKey: string, title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => Promise<void>;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    prUrl: string,
    threadRef?: ScopedThreadRef,
  ) => boolean;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}

function checkTaskPermission(environmentId: EnvironmentId): boolean {
  if (readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return true;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Action unavailable",
      description: ORCHESTRATION_OPERATE_DENIED_MESSAGE,
    }),
  );
  return false;
}

// The active row reports itself, so a route change scrolls to it once it mounts.
const RevealActiveRowContext = createContext<(row: HTMLElement | null, threadKey: string) => void>(
  () => {},
);

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const {
    orderedProjectThreadKeys,
    isActive,
    openPullRequestsInRightPanel,
    jumpLabel,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    onFileDropThreads,
    thread,
  } = props;
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(thread.environmentId, AuthPreviewOperateScope);
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: (active) => setFileDragActive(setIsFileDragOver, active),
        addFiles: (files) => {
          onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      }),
    [onFileDropThreads, threadRef],
  );
  const revealActiveRow = useContext(RevealActiveRowContext);
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(isActive);
  const appMode = useAppMode();
  const isWorkMode = appMode !== "code";
  // Work mode: drag rows between projects, Chats, and folders. A selected row
  // carries the whole selection.
  const handleWorkDragStart = useCallback(
    (event: React.DragEvent<HTMLLIElement>) => {
      const selection = useThreadSelectionStore.getState().selectedThreadKeys;
      const threadKeys = selection.has(threadKey) ? [...selection] : [threadKey];
      writeWorkThreadDrag(event.dataTransfer, threadKeys);
    },
    [threadKey],
  );
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const isMobile = useIsMobile();
  const discoveredPorts = useThreadDiscoveredPorts({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // No primary (the hosted app) means every thread is remote, and the machine
  // glyph is what tells the environments apart.
  const isRemoteThread = thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const remoteMachine = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
  // A desktop-local secondary backend (e.g. the WSL backend) shows up as a
  // bearer environment whose connection id is prefixed "local:". It runs on the
  // user's own machine, so the cloud icon is misleading, label it "Local" and
  // suppress the cloud icon (the project header already shows a
  // local-environment icon for desktop-local projects, see sidebarProjectGrouping).
  const isDesktopLocalThread =
    environment !== null && isDesktopLocalConnectionTarget(environment.entry.target);
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? (isDesktopLocalThread ? "Local" : "Remote"))
    : null;
  const isHighlighted = isActive || isSelected;
  // Work mode leads the row with this glyph; Code mode keeps it in the meta
  // slot beside the timestamp.
  const remoteMachineIndicator =
    isRemoteThread && !isDesktopLocalThread ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={threadEnvironmentLabel ?? "Remote"}
              className="inline-flex shrink-0 items-center justify-center"
            />
          }
        >
          <EnvironmentMachineIcon
            kind={remoteMachine}
            className="size-3 text-muted-foreground/40"
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
      </Tooltip>
    ) : null;
  const handleOpenDiscoveredPort = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const port = discoveredPorts[0];
      if (!port || !canOperatePreview) return;
      event.preventDefault();
      event.stopPropagation();
      navigateToThread(threadRef);
      void (async () => {
        const result = await openDiscoveredPort({ threadRef, port, openPreview });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open preview",
            description:
              error instanceof Error ? error.message : "The preview could not be opened.",
          }),
        );
      })();
    },
    [canOperatePreview, discoveredPorts, navigateToThread, openPreview, threadRef],
  );
  const isThreadRunning = !threadRuntimeCanArchive(thread.runtime);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });
  const linkedPullRequestStatus = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const pr = linkedPullRequestStatus?.pr ?? null;
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const currentLinkedPr = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;
  const prStatus = prStatusIndicator(pr, linkedPullRequestStatus?.sourceControlProvider);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive =
    canOperateThread && confirmingArchiveThreadKey === threadKey && !isThreadRunning;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : canOperateThread && !isThreadRunning
      ? "pointer-events-none transition-opacity duration-150 max-sm:pr-6 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";
  // Work mode overlays the row's icons and its hover actions in one grid cell
  // and swaps their visibility; Code mode overlays archive on the timestamp.
  const archiveButtonClassName = isWorkMode
    ? WORK_ARCHIVE_BUTTON_CLASS
    : SIDEBAR_ICON_ACTION_BUTTON_CLASS;
  const archiveActionClassName = isWorkMode
    ? "flex"
    : "pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100";
  const workThreadMetaClassName = "pointer-events-none flex";
  const workIndicatorsClassName = cn(
    "flex items-center justify-end gap-1.5 sm:col-start-1 sm:row-start-1",
    isConfirmingArchive
      ? "sm:invisible"
      : "sm:group-hover/menu-sub-item:invisible sm:group-focus-within/menu-sub-item:invisible",
  );
  // The actions take no room until hover, so titles use the full row; on hover
  // they sit over the hidden icons and shorten the title only if they are wider.
  const workActionsClassName = cn(
    "flex items-center justify-end gap-1.5 sm:col-start-1 sm:row-start-1",
    !isConfirmingArchive &&
      "sm:hidden sm:group-hover/menu-sub-item:flex sm:group-focus-within/menu-sub-item:flex",
  );
  const isPinned = useIsThreadPinned(threadKey);
  const clearConfirmingArchive = useCallback(() => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  }, [setConfirmingArchiveThreadKey, threadKey]);
  const handleMouseLeave = useCallback(() => {
    clearConfirmingArchive();
  }, [clearConfirmingArchive]);
  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLLIElement>) => {
      const currentTarget = event.currentTarget;
      requestAnimationFrame(() => {
        if (currentTarget.contains(document.activeElement)) {
          return;
        }
        clearConfirmingArchive();
      });
    },
    [clearConfirmingArchive],
  );
  const handleRowClick = useCallback(
    (event: React.MouseEvent) => {
      handleThreadClick(event, threadRef, orderedProjectThreadKeys);
    },
    [handleThreadClick, orderedProjectThreadKeys, threadRef],
  );
  const handleRowDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) return;
      // Already renaming this row: a double-click on the row chrome (outside the
      // input) must not restart and discard the in-progress edit.
      if (renamingThreadKey === threadKey) return;
      // On mobile the first tap navigates and closes the sidebar sheet, so the
      // inline rename can't be shown. Renaming there stays on the context menu.
      if (isMobile) return;
      // cmd/ctrl/shift double-clicks are multi-select intent, not rename.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // Ignore double-clicks bubbling from nested controls (PR status, port,
      // archive buttons) — only the row body should enter inline rename.
      if ((event.target as HTMLElement).closest("button, a")) return;
      event.preventDefault();
      startThreadRename(threadKey, thread.title);
    },
    [isMobile, renamingThreadKey, startThreadRename, threadKey, thread.environmentId, thread.title],
  );
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToThread(threadRef);
    },
    [navigateToThread, threadRef],
  );
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const hasSelection = useThreadSelectionStore.getState().hasSelection();
      if (hasSelection && isSelected) {
        void (async () => {
          const result = await settlePromise(() =>
            handleMultiSelectContextMenu({
              x: event.clientX,
              y: event.clientY,
            }),
          );
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Thread action failed",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
        })();
        return;
      }

      if (hasSelection) {
        clearSelection();
      }
      void (async () => {
        const result = await settlePromise(() =>
          handleThreadContextMenu(threadRef, {
            x: event.clientX,
            y: event.clientY,
          }),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Thread action failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [clearSelection, handleMultiSelectContextMenu, handleThreadContextMenu, isSelected, threadRef],
  );
  const handlePrClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      const url = prStatus?.url ?? currentLinkedPr?.url;
      if (!url) return;
      const openedInRightPanel = openPrLink(
        event,
        url,
        openPullRequestsInRightPanel ? threadRef : undefined,
      );
      if (openedInRightPanel && openPullRequestsInRightPanel && !isActive) {
        navigateToThread(threadRef);
      }
    },
    [
      isActive,
      navigateToThread,
      openPrLink,
      openPullRequestsInRightPanel,
      prStatus,
      currentLinkedPr,
      threadRef,
    ],
  );
  const handleRenameInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && renamingInputRef.current !== element) {
        renamingInputRef.current = element;
        element.focus();
        element.select();
      }
    },
    [renamingInputRef],
  );
  const handleRenameInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setRenamingTitle(event.target.value);
    },
    [setRenamingTitle],
  );
  const handleRenameInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        void commitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        cancelRename();
      }
    },
    [cancelRename, commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef],
  );
  const handleRenameInputBlur = useCallback(() => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  }, [commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef]);
  // Keep clicks/double-clicks inside the rename input from bubbling to the row.
  // Stop dblclick propagation so word selection cannot restart rename and discard edits.
  const handleRenameInputClick = useCallback((event: React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);
  const handleConfirmArchiveRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element) {
        confirmArchiveButtonRefs.current.set(threadKey, element);
      } else {
        confirmArchiveButtonRefs.current.delete(threadKey);
      }
    },
    [confirmArchiveButtonRefs, threadKey],
  );
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const handleConfirmArchiveClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      clearConfirmingArchive();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, clearConfirmingArchive, threadRef],
  );
  const handleStartArchiveConfirmation = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!checkTaskPermission(thread.environmentId)) return;
      setConfirmingArchiveThreadKey(threadKey);
      requestAnimationFrame(() => {
        confirmArchiveButtonRefs.current.get(threadKey)?.focus();
      });
    },
    [confirmArchiveButtonRefs, setConfirmingArchiveThreadKey, threadKey, thread.environmentId],
  );
  const stopClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const handleTogglePinClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      useWorkPinnedStore.getState().togglePinned(threadKey);
    },
    [threadKey],
  );
  const handleArchiveImmediateClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, threadRef],
  );
  // Work mode moves PR status to the end of the row, beside the worktree icon.
  const prIndicator = (
    <>
      {prStatus && pr && (
        <Tooltip>
          <TooltipTrigger
            render={
              <a
                href={prStatus.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={handlePrClick}
              >
                <ChangeRequestStatusIcon state={pr.state} isDraft={pr.isDraft} className="size-3" />
              </a>
            }
          />
          <TooltipPopup side="top">
            <PrStatusTooltipContent status={prStatus} />
          </TooltipPopup>
        </Tooltip>
      )}
      {!pr && currentLinkedPr ? (
        <a
          href={currentLinkedPr.url}
          target="_blank"
          rel="noopener noreferrer"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={handlePrClick}
          className="text-muted-foreground"
          aria-label={`PR #${currentLinkedPr.number}, status pending`}
        >
          <PullRequestGlyph.pullRequest className="size-3" />
        </a>
      ) : null}
    </>
  );

  const archiveControl = isConfirmingArchive ? (
    <button
      ref={handleConfirmArchiveRef}
      type="button"
      data-thread-selection-safe
      data-testid={`thread-archive-confirm-${thread.id}`}
      aria-label={`Confirm archive ${thread.title}`}
      className={cn(
        "inline-flex h-5 cursor-pointer items-center rounded-md bg-destructive/12 px-2 text-3xs font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-destructive/40",
        !isWorkMode && "absolute top-1/2 right-1 -translate-y-1/2",
      )}
      onPointerDown={stopPropagationOnPointerDown}
      onClick={handleConfirmArchiveClick}
    >
      Confirm
    </button>
  ) : canOperateThread && !isThreadRunning ? (
    appSettingsConfirmThreadArchive ? (
      <div className={archiveActionClassName}>
        <button
          type="button"
          data-thread-selection-safe
          data-testid={`thread-archive-${thread.id}`}
          aria-label={`Archive ${thread.title}`}
          className={archiveButtonClassName}
          onPointerDown={stopPropagationOnPointerDown}
          onClick={handleStartArchiveConfirmation}
        >
          <ArchiveIcon className="size-3.5" />
        </button>
      </div>
    ) : (
      <Tooltip>
        <TooltipTrigger
          render={
            <div className={archiveActionClassName}>
              <button
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-${thread.id}`}
                aria-label={`Archive ${thread.title}`}
                className={archiveButtonClassName}
                onPointerDown={stopPropagationOnPointerDown}
                onClick={handleArchiveImmediateClick}
              >
                <ArchiveIcon className="size-3.5" />
              </button>
            </div>
          }
        />
        <TooltipPopup side="top">Archive</TooltipPopup>
      </Tooltip>
    )
  ) : canOperateThread && isWorkMode ? (
    // Work rows always show archive on hover; a running chat gets it disabled
    // with the reason, so every row offers the same actions.
    <Tooltip>
      <TooltipTrigger
        render={
          <div className={archiveActionClassName}>
            <button
              type="button"
              data-thread-selection-safe
              data-testid={`thread-archive-${thread.id}`}
              aria-label={`Archive ${thread.title}`}
              aria-disabled
              className={cn(
                WORK_ARCHIVE_BUTTON_CLASS,
                "cursor-not-allowed opacity-40 hover:text-icon-muted",
              )}
              onPointerDown={stopPropagationOnPointerDown}
              onClick={stopClick}
            >
              <ArchiveIcon className="size-3.5" />
            </button>
          </div>
        }
      />
      <TooltipPopup side="top">Stop the chat to archive it</TooltipPopup>
    </Tooltip>
  ) : null;
  const threadMeta =
    isWorkMode && !threadStatus && !jumpLabel ? null : (
      <span className={isWorkMode ? workThreadMetaClassName : threadMetaClassName}>
        <span className="inline-flex items-center gap-1">
          {isWorkMode ? null : remoteMachineIndicator}
          {jumpLabel ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={jumpLabel}
                    className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
                  />
                }
              >
                {jumpLabel}
              </TooltipTrigger>
              <TooltipPopup side="top">{jumpLabel}</TooltipPopup>
            </Tooltip>
          ) : isWorkMode ? (
            threadStatus && <ThreadStatusIcon status={threadStatus} />
          ) : (
            <span
              className={`text-3xs tabular-nums ${
                isHighlighted ? "text-foreground" : "text-secondary-label"
              }`}
            >
              <RelativeTime
                timestamp={thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt}
              />
            </span>
          )}
        </span>
      </span>
    );

  return (
    <SidebarMenuSubItem
      ref={rowRef}
      className="w-full"
      data-thread-item
      {...fileDropHandlers}
      draggable={appMode === "work" && renamingThreadKey !== threadKey}
      onDragStart={appMode === "work" ? handleWorkDragStart : undefined}
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      {/* A thread row is the legacy sidebar's own control (a focusable div that hosts nested
          links and buttons), not a SidebarMenuSubButton, so it owns its look here. */}
      <div
        ref={isActive ? (node) => revealActiveRow(node, threadKey) : undefined}
        role="button"
        tabIndex={0}
        data-active={isActive}
        data-slot="sidebar-menu-sub-button"
        data-sidebar="menu-sub-button"
        data-size="sm"
        data-testid={`thread-row-${thread.id}`}
        className={cn(
          "relative isolate flex h-8 w-full min-w-0 cursor-pointer select-none items-center gap-2 overflow-hidden rounded-md px-2 text-left text-xs outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring group-data-[collapsible=icon]:hidden [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground",
          isActive
            ? "bg-sidebar-row-active font-medium text-sidebar-foreground hover:bg-sidebar-row-active"
            : isSelected
              ? "bg-sidebar-row-selected text-sidebar-foreground hover:bg-sidebar-row-active"
              : "text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
          isFileDragOver && "ring-1 ring-inset ring-primary/70",
        )}
        onClick={handleRowClick}
        onDoubleClick={handleRowDoubleClick}
        onKeyDown={handleRowKeyDown}
        onContextMenu={handleRowContextMenu}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {isWorkMode ? remoteMachineIndicator : prIndicator}
          {!isWorkMode && threadStatus && <ThreadStatusLabel status={threadStatus} />}
          {canOperateThread && renamingThreadKey === threadKey ? (
            <input
              ref={handleRenameInputRef}
              className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none"
              value={renamingTitle}
              onChange={handleRenameInputChange}
              onKeyDown={handleRenameInputKeyDown}
              onBlur={handleRenameInputBlur}
              onClick={handleRenameInputClick}
              onDoubleClick={handleRenameInputClick}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="min-w-0 flex-1 truncate text-sm"
                    data-testid={`thread-title-${thread.id}`}
                  >
                    {thread.title}
                  </span>
                }
              />
              <TooltipPopup side="top">{thread.title}</TooltipPopup>
            </Tooltip>
          )}
        </div>
        {isWorkMode ? (
          // Work mode stacks the row's icons and its hover actions in one cell,
          // so hovering swaps them in place instead of pushing the icons aside.
          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:grid sm:gap-0">
            <div className={workIndicatorsClassName}>
              {canOperatePreview && discoveredPorts.length > 0 && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={`Open localhost:${discoveredPorts[0]?.port ?? ""}`}
                        className="inline-flex cursor-pointer items-center justify-center text-success-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={handleOpenDiscoveredPort}
                      />
                    }
                  >
                    <Globe2Icon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    Open localhost:{discoveredPorts[0]?.port}
                    {discoveredPorts.length > 1 ? ` (+${discoveredPorts.length - 1})` : ""}
                  </TooltipPopup>
                </Tooltip>
              )}
              <ThreadWorktreeIndicator thread={thread} />
              {prIndicator}
              {terminalStatus ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        role="img"
                        aria-label={terminalStatus.label}
                        className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
                      />
                    }
                  >
                    <TerminalIcon
                      className={`size-3 ${terminalStatus.pulse ? "motion-safe:animate-status-pulse" : ""}`}
                      onAnimationStart={synchronizeTerminalPulse}
                    />
                  </TooltipTrigger>
                  <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
                </Tooltip>
              ) : null}
              {threadMeta}
            </div>
            <div className={workActionsClassName}>
              {canOperateThread && !isConfirmingArchive ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        data-thread-selection-safe
                        data-testid={`thread-pin-${thread.id}`}
                        aria-label={`${isPinned ? "Unpin" : "Pin"} ${thread.title}`}
                        aria-pressed={isPinned}
                        className={WORK_ARCHIVE_BUTTON_CLASS}
                        onPointerDown={stopPropagationOnPointerDown}
                        onClick={handleTogglePinClick}
                      />
                    }
                  >
                    {isPinned ? (
                      <PinOffIcon className="size-3.5" />
                    ) : (
                      <PinIcon className="size-3.5" />
                    )}
                  </TooltipTrigger>
                  <TooltipPopup side="top">{isPinned ? "Unpin" : "Pin"}</TooltipPopup>
                </Tooltip>
              ) : null}
              {archiveControl}
            </div>
          </div>
        ) : (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {canOperatePreview && discoveredPorts.length > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`Open localhost:${discoveredPorts[0]?.port ?? ""}`}
                      className="inline-flex cursor-pointer items-center justify-center text-success-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={handleOpenDiscoveredPort}
                    />
                  }
                >
                  <Globe2Icon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  Open localhost:{discoveredPorts[0]?.port}
                  {discoveredPorts.length > 1 ? ` (+${discoveredPorts.length - 1})` : ""}
                </TooltipPopup>
              </Tooltip>
            )}
            <ThreadWorktreeIndicator thread={thread} />
            <ThreadTerminalStatusButton
              threadRef={threadRef}
              terminalIds={runningTerminalIds}
              onThreadActivate={navigateToThread}
            />
            <div
              className={`flex min-w-12 justify-end ${
                isRemoteThread ? "max-sm:min-w-24" : "max-sm:min-w-20"
              }`}
            >
              {archiveControl}
              {threadMeta}
            </div>
          </div>
        )}
      </div>
    </SidebarMenuSubItem>
  );
});

interface SidebarProjectThreadListProps {
  projectKey: string;
  projectExpanded: boolean;
  hasOverflowingThreads: boolean;
  hiddenThreadStatus: ThreadStatusPill | null;
  orderedProjectThreadKeys: readonly string[];
  renderedThreads: readonly SidebarThreadSummary[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  startThreadRename: (threadKey: string, title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => Promise<void>;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    prUrl: string,
    threadRef?: ScopedThreadRef,
  ) => boolean;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
}

const SidebarProjectThreadList = memo(function SidebarProjectThreadList(
  props: SidebarProjectThreadListProps,
) {
  const {
    projectKey,
    projectExpanded,
    hasOverflowingThreads,
    hiddenThreadStatus,
    orderedProjectThreadKeys,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
    isThreadListExpanded,
    activeRouteThreadKey,
    openPullRequestsInRightPanel,
    threadJumpLabelByKey,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    attachThreadListAutoAnimateRef,
    handleThreadClick,
    navigateToThread,
    onFileDropThreads,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
    expandThreadListForProject,
    collapseThreadListForProject,
  } = props;
  const showMoreButtonRender = useMemo(() => <button type="button" />, []);
  const showLessButtonRender = useMemo(() => <button type="button" />, []);

  return (
    <SidebarMenuSub
      ref={attachThreadListAutoAnimateRef}
      className="mx-0.5 my-0 w-full translate-x-0 overflow-hidden empty:hidden sm:mx-1"
    >
      {shouldShowThreadPanel && showEmptyThreadState ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            className="flex h-8 w-full translate-x-0 items-center px-2 text-left text-xs text-sidebar-muted-foreground/75"
          >
            <span>No threads yet</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {shouldShowThreadPanel &&
        renderedThreads.map((thread) => {
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <SidebarThreadRow
              key={threadKey}
              thread={thread}
              orderedProjectThreadKeys={orderedProjectThreadKeys}
              isActive={activeRouteThreadKey === threadKey}
              openPullRequestsInRightPanel={openPullRequestsInRightPanel}
              jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
              appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
              renamingThreadKey={renamingThreadKey}
              renamingTitle={renamingTitle}
              setRenamingTitle={setRenamingTitle}
              startThreadRename={startThreadRename}
              renamingInputRef={renamingInputRef}
              renamingCommittedRef={renamingCommittedRef}
              confirmingArchiveThreadKey={confirmingArchiveThreadKey}
              setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
              confirmArchiveButtonRefs={confirmArchiveButtonRefs}
              handleThreadClick={handleThreadClick}
              navigateToThread={navigateToThread}
              onFileDropThreads={onFileDropThreads}
              handleMultiSelectContextMenu={handleMultiSelectContextMenu}
              handleThreadContextMenu={handleThreadContextMenu}
              clearSelection={clearSelection}
              commitRename={commitRename}
              cancelRename={cancelRename}
              attemptArchiveThread={attemptArchiveThread}
              openPrLink={openPrLink}
            />
          );
        })}

      {projectExpanded && hasOverflowingThreads && !isThreadListExpanded && (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={showMoreButtonRender}
            data-thread-selection-safe
            size="sm"
            onClick={() => {
              expandThreadListForProject(projectKey);
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {hiddenThreadStatus && <ThreadStatusLabel status={hiddenThreadStatus} compact />}
              <span>Show more</span>
            </span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
      {projectExpanded && hasOverflowingThreads && isThreadListExpanded && (
        <SidebarMenuSubItem className="w-full">
          <SidebarMenuSubButton
            render={showLessButtonRender}
            data-thread-selection-safe
            size="sm"
            onClick={() => {
              collapseThreadListForProject(projectKey);
            }}
          >
            <span>Show less</span>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      )}
    </SidebarMenuSub>
  );
});

interface SidebarProjectItemProps {
  project: SidebarProjectSnapshot;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  newThreadShortcutLabel: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  markThreadUnread: ReturnType<typeof useThreadActions>["markThreadUnread"];
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
}

interface SidebarThreadRowControllerInput {
  threadByKeyRef: React.RefObject<ReadonlyMap<string, SidebarThreadSummary>>;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  markThreadUnread: ReturnType<typeof useThreadActions>["markThreadUnread"];
  resolveThreadWorkspacePath: (thread: SidebarThreadSummary) => string | null;
  resolveProjectSettingsKey: (thread: SidebarThreadSummary) => string;
}

/**
 * Selection, rename, archive, and context-menu wiring for a list of
 * `SidebarThreadRow`s. Shared by project thread lists and the Work mode Chats
 * section, so both render identical rows.
 */
function useSidebarThreadRowController(input: SidebarThreadRowControllerInput) {
  const { threadByKeyRef, handleNewThread, archiveThread, deleteThread, markThreadUnread } = input;
  // Resolvers close over per-render values; read them through a ref so the
  // callbacks below stay stable and row memos hold.
  const resolversRef = useRef(input);
  resolversRef.current = input;
  const appSettingsConfirmThreadDelete = useClientSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const appSettingsConfirmThreadArchive = useClientSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const forkThread = useAtomCommand(threadEnvironment.forkFromRun, { reportFailure: false });
  const router = useRouter();
  const queuePendingFileDrop = useSidebarPendingFileDropStore((s) => s.queuePendingFileDrop);
  const clearPendingFileDrop = useSidebarPendingFileDropStore((s) => s.clearPendingFileDrop);
  const { isMobile, setOpenMobile } = useSidebar();
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Thread ID copied",
        description: ctx.threadId,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const openPrLink = useOpenPrLink();
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      return router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );
  const handleThreadFileDrop = useCallback(
    async (threadRef: ScopedThreadRef, files: File[]) => {
      const dropId = queuePendingFileDrop({ threadRef, files });
      const targetPathname = router.buildLocation({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      }).pathname;
      if (targetPathname === router.state.location.pathname) return;
      try {
        await navigateToThread(threadRef);
        if (targetPathname !== router.state.location.pathname) {
          clearPendingFileDrop(dropId);
        }
      } catch {
        clearPendingFileDrop(dropId);
      }
    },
    [clearPendingFileDrop, navigateToThread, queuePendingFileDrop, router],
  );

  const handleThreadClick = useCallback(
    (
      event: React.MouseEvent,
      threadRef: ScopedThreadRef,
      orderedProjectThreadKeys: readonly string[],
    ) => {
      if (isSidebarNestedLinkClick(event.target)) return;
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;
      const threadKey = scopedThreadKey(threadRef);
      const currentSelectionCount = useThreadSelectionStore.getState().selectedThreadKeys.size;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedProjectThreadKeys);
        return;
      }

      // Ignore the trailing click of a plain double-click so it doesn't navigate
      // while a double-click is starting an inline rename. Placed after the
      // modifier branches so cmd/shift selection still processes every click.
      if (isTrailingDoubleClick(event.detail)) {
        return;
      }

      if (currentSelectionCount > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadKey);
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [
      clearSelection,
      isMobile,
      rangeSelectTo,
      router,
      setOpenMobile,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const selectedThreadEntries = threadKeys.flatMap((threadKey) => {
        const threadRef = parseScopedThreadKey(threadKey);
        const thread = threadRef ? readThreadShell(threadRef) : null;
        return threadRef && thread ? [{ threadKey, threadRef, thread }] : [];
      });
      const hasRunningThread = selectedThreadEntries.some(
        ({ thread }) => !threadRuntimeCanArchive(thread.runtime),
      );
      const canOperateSelection = selectedThreadEntries.every(({ threadRef }) =>
        readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
      );

      const workItems = buildWorkThreadMenuItemsForKeys(threadKeys);
      const clicked = await api.contextMenu.show(
        [
          ...workItems,
          ...buildMultiSelectThreadContextMenuItems({ count, hasRunningThread }).map(
            (item, index) => ({
              ...item,
              ...(index === 0 && workItems.length > 0 ? { separatorBefore: true } : {}),
              ...(item.id === "archive" || item.id === "delete"
                ? { disabled: item.disabled || !canOperateSelection }
                : {}),
            }),
          ),
        ],
        position,
      );

      if (clicked && applyWorkThreadMenuAction(clicked, threadKeys)) {
        clearSelection();
        return;
      }

      if (clicked === "mark-unread") {
        for (const { threadRef } of selectedThreadEntries) {
          markThreadUnread(threadRef);
        }
        clearSelection();
        return;
      }

      if (
        (clicked === "archive" || clicked === "delete") &&
        !selectedThreadEntries.every(({ threadRef }) =>
          checkTaskPermission(threadRef.environmentId),
        )
      ) {
        return;
      }

      if (clicked === "archive") {
        if (appSettingsConfirmThreadArchive) {
          const confirmed = await api.dialogs.confirm(
            `Archive ${count} thread${count === 1 ? "" : "s"}?`,
          );
          if (!confirmed) return;
        }
        if (
          !selectedThreadEntries.every(({ threadRef }) =>
            checkTaskPermission(threadRef.environmentId),
          )
        ) {
          return;
        }

        const archiveOutcome = await archiveSelectedThreadEntries({
          entries: selectedThreadEntries,
          archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
        });
        for (const failure of archiveOutcome.followupFailures) {
          if (isAtomCommandInterrupted(failure)) continue;
          const error = squashAtomCommandFailure(failure);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Thread archived, but navigation failed",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        if (archiveOutcome.mutationFailure) {
          removeFromSelection(archiveOutcome.archivedThreadKeys);
          if (!isAtomCommandInterrupted(archiveOutcome.mutationFailure)) {
            const error = squashAtomCommandFailure(archiveOutcome.mutationFailure);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to archive threads",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          }
          return;
        }
        removeFromSelection(threadKeys);
        return;
      }

      if (clicked !== "delete") return;

      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) return;
      }
      if (
        !selectedThreadEntries.every(({ threadRef }) =>
          checkTaskPermission(threadRef.environmentId),
        )
      ) {
        return;
      }

      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries: selectedThreadEntries,
        delete: ({ threadRef }, deletedThreadKeys) =>
          deleteThread(threadRef, { deletedThreadKeys }),
      });
      if (firstFailure !== null) {
        const firstError = squashAtomCommandFailure(firstFailure);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete threads",
            description: firstError instanceof Error ? firstError.message : "An error occurred.",
          }),
        );
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(threadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
    [
      appSettingsConfirmThreadArchive,
      appSettingsConfirmThreadDelete,
      archiveThread,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
    ],
  );

  const attemptArchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      if (!checkTaskPermission(threadRef.environmentId)) return;
      const result = await archiveThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to archive thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [archiveThread],
  );

  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  }, []);

  const startThreadRename = useCallback((threadKey: string, title: string) => {
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef || !checkTaskPermission(threadRef.environmentId)) return;
    setRenamingThreadKey(threadKey);
    setRenamingTitle(title);
    renamingCommittedRef.current = false;
  }, []);

  const commitRename = useCallback(
    async (threadRef: ScopedThreadRef, newTitle: string, originalTitle: string) => {
      const threadKey = scopedThreadKey(threadRef);
      const finishRename = () => {
        setRenamingThreadKey((current) => {
          if (current !== threadKey) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: "Thread title cannot be empty",
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const result = await updateThreadMetadata({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          title: trimmed,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
      finishRename();
    },
    [updateThreadMetadata],
  );

  const handleThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = threadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return;
      const threadWorkspacePath = resolversRef.current.resolveThreadWorkspacePath(thread);
      const workItems = buildWorkThreadMenuItemsForKeys([threadKey]);
      const clicked = await api.contextMenu.show(
        [
          ...workItems,
          ...(thread.branch
            ? [{ id: "new-thread-on-branch", label: `New thread on ${thread.branch}` }]
            : []),
          { id: "fork", label: "Fork chat", separatorBefore: workItems.length > 0 },
          { id: "rename", label: "Rename thread" },
          ...(appAtomRegistry.get(canShareWithGuestAtom(thread.environmentId))
            ? [{ id: "share-guest", label: "Share with guest" }]
            : []),
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "project-settings", label: "Project settings" },
          { id: "delete", label: "Delete", destructive: true, icon: "trash" },
        ],
        position,
      );

      if (clicked && applyWorkThreadMenuAction(clicked, [threadKey])) {
        return;
      }

      if (clicked === "project-settings") {
        if (isMobile) setOpenMobile(false);
        void router.navigate({
          to: "/projects/$projectKey",
          params: { projectKey: resolversRef.current.resolveProjectSettingsKey(thread) },
        });
        return;
      }

      if (clicked === "new-thread-on-branch") {
        // Explicit branch carry-over: reuse the thread's worktree when it
        // has one, otherwise its branch on the local checkout.
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            envMode: thread.worktreePath ? "worktree" : "local",
            startFromOrigin: false,
          }),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "fork") {
        // Forks after the latest finished response, like the per-response fork
        // button in the timeline, then opens the new chat.
        const targetThreadRef = scopeThreadRef(thread.environmentId, newThreadId());
        const result = await forkThread({
          environmentId: thread.environmentId,
          input: {
            sourceThreadId: thread.id,
            targetThreadId: targetThreadRef.threadId,
            title: `${thread.title} fork`,
          },
        });
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not fork chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return;
        }
        if (isMobile) setOpenMobile(false);
        if (await waitForThreadShell(targetThreadRef)) {
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(targetThreadRef),
          });
        }
        return;
      }

      if (clicked === "rename") {
        startThreadRename(threadKey, thread.title);
        return;
      }

      if (clicked === "share-guest") {
        openGuestShareDialog(threadRef);
        return;
      }
      if (clicked === "mark-unread") {
        markThreadUnread(threadRef);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Path unavailable",
              description: "This thread does not have a workspace path to copy.",
            }),
          );
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(thread.id, { threadId: thread.id });
        return;
      }
      if (clicked !== "delete") return;
      if (!checkTaskPermission(threadRef.environmentId)) return;
      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) {
          return;
        }
      }
      if (!checkTaskPermission(threadRef.environmentId)) return;
      const result = await deleteThread(threadRef);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to delete thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [
      appSettingsConfirmThreadDelete,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      forkThread,
      handleNewThread,
      isMobile,
      markThreadUnread,
      router,
      setOpenMobile,
      startThreadRename,
      threadByKeyRef,
    ],
  );

  return {
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    navigateToThread,
    handleThreadFileDrop,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
  };
}

const SidebarProjectItem = memo(function SidebarProjectItem(props: SidebarProjectItemProps) {
  const {
    project,
    isThreadListExpanded,
    activeRouteThreadKey,
    openPullRequestsInRightPanel,
    newThreadShortcutLabel,
    handleNewThread,
    archiveThread,
    deleteThread,
    markThreadUnread,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    isManualProjectSorting,
    dragHandleProps,
  } = props;
  const environmentMachine = project.allRemoteMembersAreWsl
    ? "linux"
    : project.allRemoteMembersAreDesktopLocal
      ? "laptop"
      : "cloud";
  const threadSortOrder = useClientSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const sidebarThreadPreviewCount = useClientSettings<SidebarThreadPreviewCount>(
    (settings) => settings.sidebarThreadPreviewCount,
  );
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onCopy: (ctx) => {
      toastManager.add({
        type: "success",
        title: "Path copied",
        description: ctx.path,
      });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
  });
  const sidebarThreads = useThreadShellsForProjectRefs(project.memberProjectRefs);
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  // Keep a ref so callbacks can read the latest map without appearing in
  // dependency arrays (avoids invalidating every thread-row memo on each
  // thread-list change).
  const sidebarThreadByKeyRef = useRef(sidebarThreadByKey);
  sidebarThreadByKeyRef.current = sidebarThreadByKey;
  const projectThreads = sidebarThreads;
  const projectPreferenceKeys = useMemo(() => projectExpansionPreferenceKeys(project), [project]);
  const projectExpanded = useUiStateStore((state) =>
    resolveProjectExpanded(state.projectExpandedById, projectPreferenceKeys),
  );
  const threadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      projectThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const [projectRenameTarget, setProjectRenameTarget] = useState<SidebarProjectGroupMember | null>(
    null,
  );
  const [projectRenameTitle, setProjectRenameTitle] = useState("");
  const canRenameProject = useEnvironmentScope(
    projectRenameTarget?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const [projectGroupingTarget, setProjectGroupingTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const [projectGroupingSelection, setProjectGroupingSelection] = useState<
    SidebarProjectGroupingMode | "inherit"
  >("inherit");
  const memberProjectByScopedKey = useMemo(
    () =>
      new Map(
        project.memberProjects.map((member) => [
          scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
          member,
        ]),
      ),
    [project.memberProjects],
  );
  const {
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    startThreadRename,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    navigateToThread,
    handleThreadFileDrop,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    commitRename,
    cancelRename,
    attemptArchiveThread,
    openPrLink,
  } = useSidebarThreadRowController({
    threadByKeyRef: sidebarThreadByKeyRef,
    handleNewThread,
    archiveThread,
    deleteThread,
    markThreadUnread,
    resolveThreadWorkspacePath: (thread) =>
      thread.worktreePath ??
      memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      )?.workspaceRoot ??
      project.workspaceRoot ??
      null,
    resolveProjectSettingsKey: () => project.projectKey,
  });
  const memberThreadCountByPhysicalKey = useMemo(() => {
    const counts = new Map<string, number>(
      project.memberProjects.map((member) => [member.physicalProjectKey, 0] as const),
    );
    for (const thread of sidebarThreads) {
      const member = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (!member) {
        continue;
      }
      counts.set(member.physicalProjectKey, (counts.get(member.physicalProjectKey) ?? 0) + 1);
    }
    return counts;
  }, [memberProjectByScopedKey, project.memberProjects, sidebarThreads]);

  const { projectStatus, visibleProjectThreads, orderedProjectThreadKeys } = useMemo(() => {
    const lastVisitedAtByThreadKey = new Map(
      projectThreads.map((thread, index) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        resolveThreadLastVisitedAt(thread.lastVisitedAt, threadLastVisitedAts[index] ?? undefined),
      ]),
    );
    const resolveProjectThreadStatus = (thread: SidebarThreadSummary) => {
      const lastVisitedAt = lastVisitedAtByThreadKey.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      return resolveThreadStatusPill({
        thread: {
          ...thread,
          ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
        },
      });
    };
    const visibleProjectThreads = sortThreads(
      filterSidebarV2VisibleThreads(projectThreads, null),
      threadSortOrder,
    );
    const projectStatus = resolveProjectStatusIndicator(
      visibleProjectThreads.map((thread) => resolveProjectThreadStatus(thread)),
    );
    return {
      orderedProjectThreadKeys: visibleProjectThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
      projectStatus,
      visibleProjectThreads,
    };
  }, [projectThreads, threadLastVisitedAts, threadSortOrder]);
  const activeThread = useMemo(() => {
    const activeThreadKey = activeRouteThreadKey ?? undefined;
    if (!activeThreadKey) {
      return null;
    }
    return (
      visibleProjectThreads.find(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
      ) ?? null
    );
  }, [activeRouteThreadKey, visibleProjectThreads]);
  const pinnedCollapsedThread = projectExpanded ? null : activeThread;

  const {
    hasOverflowingThreads,
    hiddenThreadStatus,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
  } = useMemo(() => {
    const lastVisitedAtByThreadKey = new Map(
      projectThreads.map((thread, index) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        resolveThreadLastVisitedAt(thread.lastVisitedAt, threadLastVisitedAts[index] ?? undefined),
      ]),
    );
    const resolveProjectThreadStatus = (thread: SidebarThreadSummary) => {
      const lastVisitedAt = lastVisitedAtByThreadKey.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      return resolveThreadStatusPill({
        thread: {
          ...thread,
          ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
        },
      });
    };
    const activeThreadKey = activeRouteThreadKey ?? undefined;
    // The open thread stays listed past the preview cut, as it does in a
    // collapsed project, so it alone does not overflow the preview.
    const hasOverflowingThreads = visibleProjectThreads.some(
      (thread, index) =>
        index >= sidebarThreadPreviewCount &&
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) !== activeThreadKey,
    );
    const previewThreads =
      isThreadListExpanded || !hasOverflowingThreads
        ? visibleProjectThreads
        : visibleProjectThreads.slice(0, sidebarThreadPreviewCount);
    const visibleThreadKeys = new Set(
      [...previewThreads, ...(activeThread ? [activeThread] : [])].map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    );
    const renderedThreads = pinnedCollapsedThread
      ? [pinnedCollapsedThread]
      : visibleProjectThreads.filter((thread) =>
          visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
        );
    const hiddenThreads = visibleProjectThreads.filter(
      (thread) =>
        !visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    );
    return {
      hasOverflowingThreads,
      hiddenThreadStatus: resolveProjectStatusIndicator(
        hiddenThreads.map((thread) => resolveProjectThreadStatus(thread)),
      ),
      renderedThreads,
      showEmptyThreadState: projectExpanded && visibleProjectThreads.length === 0,
      shouldShowThreadPanel: projectExpanded || pinnedCollapsedThread !== null,
    };
  }, [
    activeRouteThreadKey,
    activeThread,
    isThreadListExpanded,
    pinnedCollapsedThread,
    projectExpanded,
    projectThreads,
    sidebarThreadPreviewCount,
    threadLastVisitedAts,
    visibleProjectThreads,
  ]);

  const handleProjectButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (suppressProjectClickForContextMenuRef.current) {
        suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (useThreadSelectionStore.getState().hasSelection()) {
        clearSelection();
      }
      setProjectExpanded(projectPreferenceKeys, !projectExpanded);
    },
    [
      clearSelection,
      dragInProgressRef,
      projectExpanded,
      projectPreferenceKeys,
      setProjectExpanded,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
    ],
  );

  const handleProjectButtonKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      setProjectExpanded(projectPreferenceKeys, !projectExpanded);
    },
    [dragInProgressRef, projectExpanded, projectPreferenceKeys, setProjectExpanded],
  );

  const handleProjectButtonPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        event.stopPropagation();
      }

      suppressProjectClickAfterDragRef.current = false;
    },
    [suppressProjectClickAfterDragRef, suppressProjectClickForContextMenuRef],
  );

  const openProjectRenameDialog = useCallback((member: SidebarProjectGroupMember) => {
    if (!checkTaskPermission(member.environmentId)) return;
    setProjectRenameTarget(member);
    setProjectRenameTitle(member.title);
  }, []);

  const openProjectGroupingDialog = useCallback(
    (member: SidebarProjectGroupMember) => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      setProjectGroupingTarget(member);
      setProjectGroupingSelection(
        projectGroupingSettings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
      );
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides],
  );

  const removeProject = useCallback(
    async (member: SidebarProjectGroupMember) => {
      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const result = await deleteProject({
        environmentId: member.environmentId,
        input: {
          projectId: member.id,
          force: true,
        },
      });
      if (result._tag === "Failure") {
        return result;
      }
      await waitForProjectRemoval(memberProjectRef);
      const draftStore = useComposerDraftStore.getState();
      releaseProjectDraftUploads(
        memberProjectRef,
        sidebarThreads
          .filter(
            (thread) =>
              thread.environmentId === member.environmentId && thread.projectId === member.id,
          )
          .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(memberProjectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(memberProjectRef);
      return result;
    },
    [deleteProject, sidebarThreads],
  );

  const handleRemoveProject = useCallback(
    async (member: SidebarProjectGroupMember) => {
      if (!checkTaskPermission(member.environmentId)) return;
      const api = readLocalApi();
      if (!api) {
        return;
      }

      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const memberThreadCount =
        (memberThreadCountByPhysicalKey.get(member.physicalProjectKey) ?? 0) +
        readUnloadedThreadCount(
          [{ environmentId: member.environmentId, id: member.id }],
          sidebarThreads,
        );
      if (memberThreadCount > 0) {
        const warningToastId = toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Project is not empty",
            description: "Delete all threads in this project before removing it.",
            actionVariant: "destructive",
            actionProps: {
              children: "Delete anyway",
              onClick: () => {
                void (async () => {
                  toastManager.close(warningToastId);
                  await new Promise<void>((resolve) => {
                    window.setTimeout(resolve, 180);
                  });
                  if (!checkTaskPermission(member.environmentId)) return;

                  const latestProjectThreads = Array.from(
                    sidebarThreadByKeyRef.current.values(),
                  ).filter(
                    (thread) =>
                      thread.environmentId === memberProjectRef.environmentId &&
                      thread.projectId === memberProjectRef.projectId,
                  );
                  const threadCount =
                    latestProjectThreads.length +
                    readUnloadedThreadCount(
                      [{ environmentId: member.environmentId, id: member.id }],
                      latestProjectThreads,
                    );
                  const confirmed = await api.dialogs.confirm(
                    threadCount > 0
                      ? [
                          `Remove project "${member.title}" and delete its ${threadCount} thread${
                            threadCount === 1 ? "" : "s"
                          }?`,
                          `Path: ${member.workspaceRoot}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This permanently clears conversation history for those threads and any archived threads.",
                          "This removes only this project entry.",
                          "This action cannot be undone.",
                        ].join("\n")
                      : [
                          `Remove project "${member.title}"?`,
                          `Path: ${member.workspaceRoot}`,
                          ...(member.environmentLabel
                            ? [`Environment: ${member.environmentLabel}`]
                            : []),
                          "This permanently clears any archived conversation history.",
                          "This removes only this project entry.",
                        ].join("\n"),
                    { variant: "destructive" },
                  );
                  if (!confirmed) {
                    return;
                  }

                  const result = await removeProject(member);
                  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                    const error = squashAtomCommandFailure(result);
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: `Failed to remove "${member.title}"`,
                        description:
                          error instanceof Error
                            ? error.message
                            : "Unknown error removing project.",
                      }),
                    );
                  }
                })().catch((error) => {
                  const message =
                    error instanceof Error ? error.message : "Unknown error removing project.";
                  console.error("Failed to remove project", {
                    projectId: member.id,
                    environmentId: member.environmentId,
                    ...safeErrorLogAttributes(error),
                  });
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: `Failed to remove "${member.title}"`,
                      description: message,
                    }),
                  );
                });
              },
            },
          }),
        );
        return;
      }

      const message = [
        `Remove project "${member.title}"?`,
        `Path: ${member.workspaceRoot}`,
        ...(member.environmentLabel ? [`Environment: ${member.environmentLabel}`] : []),
        "This permanently clears any archived conversation history.",
        "This removes only this project entry.",
      ].join("\n");
      const confirmed = await api.dialogs.confirm(message, { variant: "destructive" });
      if (!confirmed) {
        return;
      }

      const result = await removeProject(member);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        const message = error instanceof Error ? error.message : "Unknown error removing project.";
        console.error("Failed to remove project", {
          projectId: member.id,
          environmentId: member.environmentId,
          ...safeErrorLogAttributes(error),
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to remove "${member.title}"`,
            description: message,
          }),
        );
      }
    },
    [memberThreadCountByPhysicalKey, removeProject, sidebarThreads],
  );

  const handleProjectButtonContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      suppressProjectClickForContextMenuRef.current = true;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const actionHandlers = new Map<string, () => Promise<void> | void>();
        const makeLeaf = (
          action: "rename" | "grouping" | "copy-path" | "delete",
          member: SidebarProjectGroupMember,
          options?: {
            destructive?: boolean;
            disabled?: boolean;
          },
        ): ContextMenuItem<string> => {
          const id = `${action}:${member.physicalProjectKey}`;
          actionHandlers.set(id, () => {
            switch (action) {
              case "rename":
                openProjectRenameDialog(member);
                return;
              case "grouping":
                openProjectGroupingDialog(member);
                return;
              case "copy-path":
                copyPathToClipboard(member.workspaceRoot, { path: member.workspaceRoot });
                return;
              case "delete":
                return handleRemoveProject(member);
            }
          });

          return {
            id,
            label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
            ...(options?.destructive ? { destructive: true } : {}),
            ...(options?.disabled ? { disabled: true } : {}),
          };
        };

        const buildTargetedItem = (
          action: "rename" | "grouping" | "copy-path" | "delete",
          label: string,
          options?: {
            destructive?: boolean;
            isDisabled?: (member: SidebarProjectGroupMember) => boolean;
          },
        ): ContextMenuItem<string> => {
          if (project.memberProjects.length === 1) {
            const singleMember = project.memberProjects[0]!;
            return {
              ...makeLeaf(action, singleMember, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(singleMember) ? { disabled: true } : {}),
              }),
              label,
              ...(action === "delete" ? { icon: "trash" } : {}),
            };
          }

          return {
            id: `${action}:submenu`,
            label,
            ...(action === "delete" ? { icon: "trash" } : {}),
            children: project.memberProjects.map((member) =>
              makeLeaf(action, member, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(member) ? { disabled: true } : {}),
              }),
            ),
          };
        };

        actionHandlers.set("project-settings", () => {
          if (isMobile) setOpenMobile(false);
          void router.navigate({
            to: "/projects/$projectKey",
            params: { projectKey: project.projectKey },
          });
        });

        const clicked = await api.contextMenu.show(
          [
            buildTargetedItem("rename", "Rename", {
              isDisabled: (member) =>
                !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
            }),
            buildTargetedItem("grouping", "Group into..."),
            buildTargetedItem("copy-path", "Copy Path"),
            { id: "project-settings", label: "Project settings", icon: "settings" },
            buildTargetedItem("delete", "Remove", {
              destructive: true,
              isDisabled: (member) =>
                !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
            }),
          ],
          {
            x: event.clientX,
            y: event.clientY,
          },
        );

        if (!clicked) {
          return;
        }

        await actionHandlers.get(clicked)?.();
      })();
    },
    [
      copyPathToClipboard,
      handleRemoveProject,
      isMobile,
      openProjectGroupingDialog,
      openProjectRenameDialog,
      project.groupedProjectCount,
      project.memberProjects,
      project.projectKey,
      router,
      setOpenMobile,
      suppressProjectClickForContextMenuRef,
    ],
  );

  const createThreadForProjectMember = useCallback(
    (member: SidebarProjectGroupMember) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void (async () => {
        // No options: branch, worktree, and env mode come from the user's
        // configured defaults, never from the currently viewed thread.
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(member.environmentId, member.id)),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [handleNewThread, isMobile, setOpenMobile],
  );

  const handleCreateThreadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (project.memberProjects.length === 1) {
        createThreadForProjectMember(project.memberProjects[0]!);
        return;
      }

      void (async () => {
        const api = readLocalApi();
        if (!api) {
          return;
        }
        const clickedResult = await settlePromise(() =>
          api.contextMenu.show(
            project.memberProjects.map((member) => ({
              id: member.physicalProjectKey,
              label: formatProjectMemberActionLabel(member, project.groupedProjectCount),
            })),
            {
              x: event.clientX,
              y: event.clientY,
            },
          ),
        );
        if (clickedResult._tag === "Failure") {
          const error = squashAtomCommandFailure(clickedResult);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not choose environment",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return;
        }
        const clicked = clickedResult.value;
        if (!clicked) {
          return;
        }
        const targetMember = project.memberProjects.find(
          (member) => member.physicalProjectKey === clicked,
        );
        if (!targetMember) {
          return;
        }
        createThreadForProjectMember(targetMember);
      })();
    },
    [createThreadForProjectMember, project.groupedProjectCount, project.memberProjects],
  );

  const closeProjectRenameDialog = useCallback(() => {
    setProjectRenameTarget(null);
    setProjectRenameTitle("");
  }, []);

  const submitProjectRename = useCallback(async () => {
    if (!projectRenameTarget) {
      return;
    }

    const trimmed = projectRenameTitle.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: "Project title cannot be empty",
      });
      return;
    }

    if (trimmed === projectRenameTarget.title) {
      closeProjectRenameDialog();
      return;
    }

    const result = await updateProject({
      environmentId: projectRenameTarget.environmentId,
      input: {
        projectId: projectRenameTarget.id,
        title: trimmed,
      },
    });
    if (result._tag === "Success") {
      closeProjectRenameDialog();
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to rename project",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  }, [closeProjectRenameDialog, projectRenameTarget, projectRenameTitle, updateProject]);

  const closeProjectGroupingDialog = useCallback(() => {
    setProjectGroupingTarget(null);
    setProjectGroupingSelection("inherit");
  }, []);

  const saveProjectGroupingPreference = useCallback(() => {
    if (!projectGroupingTarget) {
      return;
    }

    const overrideKey = deriveProjectGroupingOverrideKey(projectGroupingTarget);
    const nextOverrides = {
      ...projectGroupingSettings.sidebarProjectGroupingOverrides,
    };
    if (projectGroupingSelection === "inherit") {
      delete nextOverrides[overrideKey];
    } else {
      nextOverrides[overrideKey] = projectGroupingSelection;
    }
    updateClientSettings({
      sidebarProjectGroupingOverrides: nextOverrides,
    });
    closeProjectGroupingDialog();
  }, [
    closeProjectGroupingDialog,
    projectGroupingSelection,
    projectGroupingSettings.sidebarProjectGroupingOverrides,
    projectGroupingTarget,
  ]);

  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          className={isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : undefined}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          onPointerDownCapture={handleProjectButtonPointerDownCapture}
          onClick={handleProjectButtonClick}
          onKeyDown={handleProjectButtonKeyDown}
          onContextMenu={handleProjectButtonContextMenu}
        >
          {!projectExpanded && projectStatus ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    aria-label={projectStatus.label}
                    className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
                  />
                }
              >
                <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                  <span
                    className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                      projectStatus.pulse ? "motion-safe:animate-status-pulse" : ""
                    }`}
                  />
                </span>
                <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-icon-muted opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
              </TooltipTrigger>
              <TooltipPopup side="top">{projectStatus.label}</TooltipPopup>
            </Tooltip>
          ) : (
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                projectExpanded ? "rotate-90" : ""
              }`}
            />
          )}
          <span className="flex shrink-0">
            <ProjectFavicon project={project} />
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-sm font-medium text-sidebar-foreground/90">
              {project.displayName}
            </span>
            {project.groupedProjectCount > 1 ? (
              <span className="shrink-0 text-secondary-label text-3xs">
                {project.groupedProjectCount} projects
              </span>
            ) : null}
          </span>
          {/* Keeps the name clear of the environment badge and new-thread button overlaid on
              the row's end (two slots on touch, where both stay visible). */}
          <span aria-hidden className="w-4 shrink-0 max-sm:w-10" />
        </SidebarMenuButton>
        {/* Environment badge – visible by default, crossfades with the
            "new thread" button on hover using the same pointer-events +
            opacity pattern as the thread row archive/timestamp swap. */}
        {project.environmentPresence === "remote-only" && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={
                    project.allRemoteMembersAreDesktopLocal
                      ? "Local sandbox project"
                      : "Remote project"
                  }
                  className="pointer-events-none absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-icon-muted transition-opacity duration-150 max-sm:right-7 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0 max-sm:group-hover/project-header:opacity-100 max-sm:group-focus-within/project-header:opacity-100"
                />
              }
            >
              <EnvironmentMachineIcon kind={environmentMachine} className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {project.allRemoteMembersAreDesktopLocal
                ? `Local sandbox: ${project.remoteEnvironmentLabels.join(", ")}`
                : `Remote environment: ${project.remoteEnvironmentLabels.join(", ")}`}
            </TooltipPopup>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="pointer-events-none absolute top-[calc(50%+1px)] right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
                <button
                  type="button"
                  aria-label={`Create new thread in ${project.displayName}`}
                  data-testid="new-thread-button"
                  className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                  onClick={handleCreateThreadClick}
                >
                  <SquarePenIcon className="size-3.5" />
                </button>
              </div>
            }
          />
          <TooltipPopup side="top">
            {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
          </TooltipPopup>
        </Tooltip>
      </div>

      <SidebarProjectThreadList
        projectKey={project.projectKey}
        projectExpanded={projectExpanded}
        hasOverflowingThreads={hasOverflowingThreads}
        hiddenThreadStatus={hiddenThreadStatus}
        orderedProjectThreadKeys={orderedProjectThreadKeys}
        renderedThreads={renderedThreads}
        showEmptyThreadState={showEmptyThreadState}
        shouldShowThreadPanel={shouldShowThreadPanel}
        isThreadListExpanded={isThreadListExpanded}
        activeRouteThreadKey={activeRouteThreadKey}
        openPullRequestsInRightPanel={openPullRequestsInRightPanel}
        threadJumpLabelByKey={threadJumpLabelByKey}
        appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
        renamingThreadKey={renamingThreadKey}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        startThreadRename={startThreadRename}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        confirmingArchiveThreadKey={confirmingArchiveThreadKey}
        setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
        confirmArchiveButtonRefs={confirmArchiveButtonRefs}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        onFileDropThreads={handleThreadFileDrop}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        attemptArchiveThread={attemptArchiveThread}
        openPrLink={openPrLink}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
      />

      <Dialog
        open={projectRenameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectRenameDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              {projectRenameTarget
                ? `Update the title for ${projectRenameTarget.workspaceRoot}.`
                : "Update the project title."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Project title</span>
              <Input
                aria-label="Project title"
                disabled={!canRenameProject}
                value={projectRenameTitle}
                onChange={(event) => setProjectRenameTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitProjectRename();
                  }
                }}
              />
            </div>
            {projectRenameTarget?.environmentLabel ? (
              <p className="text-xs text-muted-foreground">
                Environment: {projectRenameTarget.environmentLabel}
              </p>
            ) : null}
            {!canRenameProject ? (
              <p className="text-xs text-muted-foreground">
                This connection cannot change projects.
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRenameDialog}>
              Cancel
            </Button>
            <Button disabled={!canRenameProject} onClick={() => void submitProjectRename()}>
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={projectGroupingTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectGroupingDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Project grouping</DialogTitle>
            <DialogDescription>
              {projectGroupingTarget
                ? `Choose how ${projectGroupingTarget.workspaceRoot} should be grouped in the sidebar.`
                : "Choose how this project should be grouped in the sidebar."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Grouping rule</span>
              <Select
                value={projectGroupingSelection}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    setProjectGroupingSelection(value);
                  }
                }}
              >
                <SelectTrigger className="w-full" aria-label="Project grouping rule">
                  <SelectValue>
                    {projectGroupingSelection === "inherit"
                      ? `Use global default (${PROJECT_GROUPING_MODE_LABELS[projectGroupingSettings.sidebarProjectGroupingMode]})`
                      : PROJECT_GROUPING_MODE_LABELS[projectGroupingSelection]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="inherit">
                    Use global default
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {projectGroupingSelection === "inherit"
                ? projectGroupingModeDescription(projectGroupingSettings.sidebarProjectGroupingMode)
                : projectGroupingModeDescription(projectGroupingSelection)}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectGroupingDialog}>
              Cancel
            </Button>
            <Button onClick={saveProjectGroupingPreference}>Save</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});

const SidebarProjectListRow = memo(function SidebarProjectListRow(props: SidebarProjectItemProps) {
  return (
    <SidebarMenuItem>
      <SidebarProjectItem {...props} />
    </SidebarMenuItem>
  );
});

function LocalSecondaryStatus() {
  const { environments } = useEnvironments();
  // The desktop reports which local secondary backends (e.g. the WSL backend)
  // exist; the hook polls because the bridge has no change event. A backend that
  // is still cold-booting has no httpBaseUrl yet and isn't in the catalog, so we
  // surface "Connecting" straight from the bootstrap list and clear it once the
  // matching environment reports a connected phase.
  const secondaries = useDesktopLocalBootstraps();

  // Connected desktop-local environments keyed by their backend URL so we can
  // match a bootstrap (which only knows the URL) to its connection phase.
  const localEnvByUrl = useMemo(() => {
    const map = new Map<string, { phase: string; error: string | null }>();
    for (const environment of environments) {
      if (
        isDesktopLocalConnectionTarget(environment.entry.target) &&
        environment.displayUrl !== null
      ) {
        map.set(environment.displayUrl, {
          phase: environment.connection.phase,
          error: environment.connection.error,
        });
      }
    }
    return map;
  }, [environments]);

  const connecting: string[] = [];
  const failed: Array<{ label: string; error: string | null }> = [];
  for (const bootstrap of secondaries) {
    const env =
      bootstrap.httpBaseUrl !== null ? localEnvByUrl.get(bootstrap.httpBaseUrl) : undefined;
    if (env?.phase === "connected") {
      continue;
    }
    if (env?.phase === "error") {
      failed.push({ label: bootstrap.label, error: env.error });
      continue;
    }
    connecting.push(bootstrap.label);
  }

  if (connecting.length === 0 && failed.length === 0) {
    return null;
  }

  return (
    <SidebarGroup>
      {connecting.length > 0 ? (
        <Alert variant="sidebar">
          <Spinner />
          <AlertTitle>Connecting {connecting.join(", ")}</AlertTitle>
        </Alert>
      ) : null}
      {failed.length > 0 ? (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>Couldn't connect {failed.map((entry) => entry.label).join(", ")}</AlertTitle>
          <AlertDescription>
            {failed
              .map((entry) => entry.error)
              .filter(Boolean)
              .join("; ") || "The backend didn't respond."}
          </AlertDescription>
        </Alert>
      ) : null}
    </SidebarGroup>
  );
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  threadPreviewCount,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
  onThreadPreviewCountChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  threadPreviewCount: SidebarThreadPreviewCount;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onThreadPreviewCountChange: (count: SidebarThreadPreviewCount) => void;
}) {
  const handleThreadPreviewCountChange = useCallback(
    (nextValue: number | null) => {
      if (nextValue === null) {
        return;
      }

      const clampedValue = clampSidebarThreadPreviewCount(nextValue);
      if (clampedValue !== threadPreviewCount) {
        onThreadPreviewCountChange(clampedValue);
      }
    },
    [onThreadPreviewCountChange, threadPreviewCount],
  );

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost-muted" aria-label="Sidebar options" />}
            />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sidebar options</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            Sort projects
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(Object.entries(SIDEBAR_SORT_LABELS) as Array<[SidebarProjectSortOrder, string]>).map(
              ([value, label]) => (
                <MenuRadioItem key={value} value={value}>
                  {label}
                </MenuRadioItem>
              ),
            )}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value}>
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 text-muted-foreground sm:text-xs font-medium">
            Visible threads
          </div>
          <div className="px-2 py-1">
            <NumberField
              aria-label="Visible thread count"
              className="w-28"
              max={MAX_SIDEBAR_THREAD_PREVIEW_COUNT}
              min={MIN_SIDEBAR_THREAD_PREVIEW_COUNT}
              onValueChange={handleThreadPreviewCountChange}
              size="sm"
              step={1}
              value={threadPreviewCount}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement
                  aria-label="Decrease visible thread count"
                  className="[&_svg]:size-3.5"
                />
                <NumberFieldInput
                  aria-label="Visible thread count"
                  inputMode="numeric"
                  onKeyDownCapture={(event) => {
                    event.stopPropagation();
                  }}
                />
                <NumberFieldIncrement
                  aria-label="Increase visible thread count"
                  className="[&_svg]:size-3.5"
                />
              </NumberFieldGroup>
            </NumberField>
          </div>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: string;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-inset ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

interface SidebarProjectsContentProps {
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  desktopUpdateButtonAction: "download" | "install" | "none";
  desktopUpdateButtonDisabled: boolean;
  desktopUpdateActionPending: boolean;
  handleDesktopUpdateButtonClick: () => void;
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  threadPreviewCount: SidebarThreadPreviewCount;
  openAddProject: () => void;
  isManualProjectSorting: boolean;
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  markThreadUnread: ReturnType<typeof useThreadActions>["markThreadUnread"];
  sortedProjects: readonly SidebarProjectSnapshot[];
  expandedThreadListsByProject: ReadonlySet<string>;
  activeRouteProjectKey: string | null;
  routeThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  newThreadShortcutLabel: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  attachProjectListAutoAnimateRef: (node: HTMLElement | null) => void;
  projectsLength: number;
  resolveLogicalProjectKey: (thread: SidebarThreadSummary) => string;
}

const WORK_PROJECT_INDENT_PX = 12;

interface SidebarWorkSectionsProps {
  repositoryRows: React.ReactNode;
  hasRepositories: boolean;
  routeThreadKey: string | null;
  openPullRequestsInRightPanel: boolean;
  newThreadShortcutLabel: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>;
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  markThreadUnread: ReturnType<typeof useThreadActions>["markThreadUnread"];
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandedThreadListsByProject: ReadonlySet<string>;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  resolveLogicalProjectKey: (thread: SidebarThreadSummary) => string;
}

/** Drop target: a Work project id, or null for Chats. */
type WorkDropTarget = {
  projectId: string | null;
  /** Set while a project is dragged: where it lands relative to this project. */
  reorder?: "before" | "after";
};

/**
 * Work mode's sidebar body: user-created Projects, not tied to repositories,
 * and Chats, every thread that is in none of them. Rows are the same
 * `SidebarThreadRow`s the Code mode project lists render.
 */
const SidebarWorkSections = memo(function SidebarWorkSections(props: SidebarWorkSectionsProps) {
  const {
    routeThreadKey,
    openPullRequestsInRightPanel,
    newThreadShortcutLabel,
    handleNewThread,
    archiveThread,
    deleteThread,
    markThreadUnread,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandedThreadListsByProject,
    expandThreadListForProject,
    collapseThreadListForProject,
    resolveLogicalProjectKey,
  } = props;
  const threads = useThreadShells();
  const repositoryProjects = useProjects();
  const workState = useWorkModeStore(
    useShallow((state) => ({
      folders: state.folders,
      threadFolderByKey: state.threadFolderByKey,
      collapsedFolderIds: state.collapsedFolderIds,
      editingFolderId: state.editingFolderId,
    })),
  );
  const { folders, threadFolderByKey, collapsedFolderIds, editingFolderId } = workState;
  const pinnedThreadKeys = useWorkPinnedStore((state) => state.pinnedThreadKeys);
  const threadSortOrder = useClientSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const threadPreviewCount = useClientSettings<SidebarThreadPreviewCount>(
    (settings) => settings.sidebarThreadPreviewCount,
  );
  const { isMobile, setOpenMobile } = useSidebar();
  const [dropTarget, setDropTarget] = useState<WorkDropTarget | null>(null);

  const threadByKey = useMemo(
    () =>
      new Map(
        threads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [threads],
  );
  const threadByKeyRef = useRef(threadByKey);
  threadByKeyRef.current = threadByKey;
  const repositoryProjectByKey = useMemo(
    () =>
      new Map(
        repositoryProjects.map(
          (project) =>
            [
              scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
              project,
            ] as const,
        ),
      ),
    [repositoryProjects],
  );
  const firstmateThreadKeys = useFirstmateCoordinatorThreadKeys(); // fork: firstmate
  const agentThreadKeys = useAgentCoordinatorThreadKeys(); // fork: agents
  // Custom agents' worker chats are reached from their task lists, not Chats.
  const agentWorkerThreadKeys = useCustomAgentWorkerThreadKeys(); // fork: agents
  const hiddenThreadKeys = useMemo(
    () => new Set([...firstmateThreadKeys, ...agentThreadKeys, ...agentWorkerThreadKeys]),
    [firstmateThreadKeys, agentThreadKeys, agentWorkerThreadKeys],
  ); // fork: agents
  const groups = useMemo(
    () =>
      groupWorkThreads(
        threads,
        { folders, threadFolderByKey },
        threadSortOrder,
        pinnedThreadKeys,
        hiddenThreadKeys,
      ),
    [folders, hiddenThreadKeys, pinnedThreadKeys, threadFolderByKey, threadSortOrder, threads],
  );
  const projectTree = useMemo(() => buildWorkFolderTree(folders), [folders]);
  const collapsedProjectIds = useMemo(() => new Set(collapsedFolderIds), [collapsedFolderIds]);

  const controller = useSidebarThreadRowController({
    threadByKeyRef,
    handleNewThread,
    archiveThread,
    deleteThread,
    markThreadUnread,
    resolveThreadWorkspacePath: (thread) =>
      thread.worktreePath ??
      repositoryProjectByKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      )?.workspaceRoot ??
      null,
    resolveProjectSettingsKey: resolveLogicalProjectKey,
  });

  useEffect(() => {
    if (dropTarget === null) return;
    const clear = () => setDropTarget(null);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, [dropTarget]);

  /**
   * Every server thread needs a repository project to run in. A new Work chat
   * opens at once in the open chat's repository, the saved default, or the
   * most recently used one, so it never asks which repository to use.
   */
  const createChat = useCallback(
    (workProjectId: string | null, _position: { x: number; y: number }) => {
      void (async () => {
        const activeThread = routeThreadKey ? threadByKeyRef.current.get(routeThreadKey) : null;
        const projectKey = resolveWorkChatRepositoryKey({
          activeProjectKey: activeThread
            ? scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId))
            : null,
          defaultProjectKey: useWorkModeStore.getState().defaultProjectKey,
          projectKeys: new Set(repositoryProjectByKey.keys()),
          threads: [...threadByKeyRef.current.values()].filter(
            (thread) => thread.archivedAt === null,
          ),
          scopedProjectKey: (environmentId, projectId) =>
            scopedProjectKey(
              scopeProjectRef(environmentId as EnvironmentId, projectId as ProjectId),
            ),
          excludedProjectKeys: new Set([
            ...readFirstmateHomeProjectKeys(),
            ...readAgentHomeProjectKeys(),
          ]), // fork: firstmate, agents
        });
        const picked = projectKey === null ? undefined : repositoryProjectByKey.get(projectKey);
        if (!picked) return;
        const projectRef = scopeProjectRef(picked.environmentId, picked.id);
        if (isMobile) setOpenMobile(false);
        const result = await settlePromise(() => handleNewThread(projectRef));
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return;
        }
        if (result.value && workProjectId !== null) {
          useWorkModeStore
            .getState()
            .fileThreads(
              [scopedThreadKey(scopeThreadRef(projectRef.environmentId, result.value.threadId))],
              workProjectId,
            );
        }
      })();
    },
    [handleNewThread, isMobile, repositoryProjectByKey, routeThreadKey, setOpenMobile],
  );

  const createProject = useCallback(() => {
    const store = useWorkModeStore.getState();
    const projectId = store.createFolder("New project", null);
    store.setEditingFolderId(projectId);
  }, []);

  const handleProjectContextMenu = useCallback(
    (node: WorkFolderNode, position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        const { folder } = node;
        const clicked = await api.contextMenu.show(
          [
            { id: "new-chat", label: "New chat in project" },
            { id: "rename", label: "Rename project", separatorBefore: true },
            { id: "delete", label: "Delete project", destructive: true, icon: "trash" },
          ],
          position,
        );
        const store = useWorkModeStore.getState();
        switch (clicked) {
          case "new-chat":
            createChat(folder.id, position);
            return;
          case "rename":
            store.setEditingFolderId(folder.id);
            return;
          case "delete": {
            const confirmed = await api.dialogs.confirm(
              [
                `Delete project "${folder.name}"?`,
                "Its chats move back to Chats. No chats are deleted.",
              ].join("\n"),
              { variant: "destructive" },
            );
            if (confirmed) store.deleteFolder(folder.id);
            return;
          }
        }
      })();
    },
    [createChat],
  );

  const dropHandlers = useCallback(
    (target: WorkDropTarget) => ({
      onDragOver: (event: React.DragEvent<HTMLElement>) => {
        if (isWorkProjectDrag(event.dataTransfer)) {
          if (target.projectId === null) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          const reorder = resolveDropPosition(
            event.clientY,
            event.currentTarget.getBoundingClientRect(),
          );
          setDropTarget((current) =>
            current?.projectId === target.projectId && current.reorder === reorder
              ? current
              : { projectId: target.projectId, reorder },
          );
          return;
        }
        if (!isWorkThreadDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropTarget((current) =>
          current?.projectId === target.projectId && current.reorder === undefined
            ? current
            : target,
        );
      },
      onDrop: (event: React.DragEvent<HTMLElement>) => {
        const draggedProjectId = event.dataTransfer.getData(WORK_PROJECT_DRAG_TYPE);
        if (draggedProjectId) {
          if (target.projectId === null) return;
          event.preventDefault();
          event.stopPropagation();
          setDropTarget(null);
          useWorkModeStore
            .getState()
            .reorderFolder(
              draggedProjectId,
              target.projectId,
              resolveDropPosition(event.clientY, event.currentTarget.getBoundingClientRect()),
            );
          return;
        }
        const threadKeys = readWorkThreadDrag(event.dataTransfer);
        if (!threadKeys) return;
        event.preventDefault();
        event.stopPropagation();
        setDropTarget(null);
        useWorkModeStore.getState().fileThreads(threadKeys, target.projectId);
      },
    }),
    [],
  );

  const renderThreadList = (
    listKey: string,
    listThreads: readonly SidebarThreadSummary[],
    expanded: boolean,
  ) => {
    const orderedThreadKeys = listThreads.map((thread) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
    const pinnedThread =
      !expanded && routeThreadKey
        ? (listThreads.find(
            (thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === routeThreadKey,
          ) ?? null)
        : null;
    const isThreadListExpanded = expandedThreadListsByProject.has(listKey);
    const hasOverflowingThreads = listThreads.length > threadPreviewCount;
    const renderedThreads = pinnedThread
      ? [pinnedThread]
      : isThreadListExpanded || !hasOverflowingThreads
        ? listThreads
        : listThreads.slice(0, threadPreviewCount);
    return (
      <SidebarProjectThreadList
        projectKey={listKey}
        projectExpanded={expanded}
        hasOverflowingThreads={hasOverflowingThreads}
        hiddenThreadStatus={null}
        orderedProjectThreadKeys={orderedThreadKeys}
        renderedThreads={renderedThreads}
        showEmptyThreadState={expanded && listThreads.length === 0}
        shouldShowThreadPanel={expanded || pinnedThread !== null}
        isThreadListExpanded={isThreadListExpanded}
        activeRouteThreadKey={routeThreadKey}
        openPullRequestsInRightPanel={openPullRequestsInRightPanel}
        threadJumpLabelByKey={threadJumpLabelByKey}
        appSettingsConfirmThreadArchive={controller.appSettingsConfirmThreadArchive}
        renamingThreadKey={controller.renamingThreadKey}
        renamingTitle={controller.renamingTitle}
        setRenamingTitle={controller.setRenamingTitle}
        startThreadRename={controller.startThreadRename}
        renamingInputRef={controller.renamingInputRef}
        renamingCommittedRef={controller.renamingCommittedRef}
        confirmingArchiveThreadKey={controller.confirmingArchiveThreadKey}
        setConfirmingArchiveThreadKey={controller.setConfirmingArchiveThreadKey}
        confirmArchiveButtonRefs={controller.confirmArchiveButtonRefs}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        handleThreadClick={controller.handleThreadClick}
        navigateToThread={controller.navigateToThread}
        onFileDropThreads={controller.handleThreadFileDrop}
        handleMultiSelectContextMenu={controller.handleMultiSelectContextMenu}
        handleThreadContextMenu={controller.handleThreadContextMenu}
        clearSelection={controller.clearSelection}
        commitRename={controller.commitRename}
        cancelRename={controller.cancelRename}
        attemptArchiveThread={controller.attemptArchiveThread}
        openPrLink={controller.openPrLink}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
      />
    );
  };

  const renderProject = (node: WorkFolderNode): React.ReactNode => {
    const { folder } = node;
    const expanded = !collapsedProjectIds.has(folder.id);
    const isDropTarget = dropTarget?.projectId === folder.id && dropTarget.reorder === undefined;
    const reorderMarker = dropTarget?.projectId === folder.id ? dropTarget.reorder : undefined;
    const indentStyle = { paddingLeft: `${8 + node.depth * WORK_PROJECT_INDENT_PX}px` };
    return (
      <SidebarMenuItem key={folder.id} {...dropHandlers({ projectId: folder.id })}>
        <div
          className={cn(
            "relative rounded-md transition-colors",
            isDropTarget && "bg-sidebar-row-hover/60",
            reorderMarker === "before" &&
              "before:absolute before:inset-x-1 before:-top-0.5 before:h-0.5 before:rounded-full before:bg-primary",
            reorderMarker === "after" &&
              "after:absolute after:inset-x-1 after:-bottom-0.5 after:h-0.5 after:rounded-full after:bg-primary",
          )}
        >
          <div
            className="group/project-header relative"
            draggable={editingFolderId !== folder.id}
            onDragStart={(event) => {
              event.stopPropagation();
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(WORK_PROJECT_DRAG_TYPE, folder.id);
            }}
          >
            {editingFolderId === folder.id ? (
              <div className="flex h-8 w-full items-center gap-2 pr-2" style={indentStyle}>
                <WorkProjectNameInput
                  initialName={folder.name}
                  onCommit={(name) => {
                    const store = useWorkModeStore.getState();
                    store.renameFolder(folder.id, name);
                    store.setEditingFolderId(null);
                  }}
                  onCancel={() => useWorkModeStore.getState().setEditingFolderId(null)}
                />
              </div>
            ) : (
              <SidebarMenuButton
                style={indentStyle}
                onClick={() => {
                  useWorkModeStore.getState().setFolderCollapsed(folder.id, expanded);
                }}
                onDoubleClick={() => useWorkModeStore.getState().setEditingFolderId(folder.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  handleProjectContextMenu(node, { x: event.clientX, y: event.clientY });
                }}
              >
                {/* Leaves room for the new-chat action at the end of the row. */}
                <span className="flex min-w-0 flex-1 items-center gap-1 pr-6 max-sm:pr-12">
                  <span className="truncate text-sm font-medium text-sidebar-foreground/90">
                    {folder.name}
                  </span>
                  {/* Collapse state shows on hover, right of the name. */}
                  <ChevronRightIcon
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground/70 opacity-0 transition-[opacity,transform] duration-150 group-hover/project-header:opacity-100",
                      expanded && "rotate-90",
                    )}
                  />
                </span>
              </SidebarMenuButton>
            )}
            {editingFolderId !== folder.id ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <div className="pointer-events-none absolute top-[calc(50%+1px)] right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
                      <button
                        type="button"
                        aria-label={`Create new chat in ${folder.name}`}
                        className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          createChat(folder.id, { x: event.clientX, y: event.clientY });
                        }}
                      >
                        <SquarePenIcon className="size-3.5" />
                      </button>
                    </div>
                  }
                />
                <TooltipPopup side="top">
                  {newThreadShortcutLabel ? `New chat (${newThreadShortcutLabel})` : "New chat"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
          {expanded && node.children.length > 0 ? (
            <SidebarMenu className="mt-1">{node.children.map(renderProject)}</SidebarMenu>
          ) : null}
          <div style={{ paddingLeft: `${node.depth * WORK_PROJECT_INDENT_PX}px` }}>
            {renderThreadList(
              `work-project:${folder.id}`,
              groups.byProjectId.get(folder.id) ?? [],
              expanded,
            )}
          </div>
        </div>
      </SidebarMenuItem>
    );
  };

  const isChatsDropTarget = dropTarget !== null && dropTarget.projectId === null;

  return (
    <>
      {groups.pinned.length > 0 ? (
        <SidebarGroup data-testid="work-pinned-section" className="pb-3">
          <div className="mb-1 flex h-6 items-center pl-2 pr-1.5">
            <span className="text-xs font-medium text-sidebar-muted-foreground/80">Pinned</span>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>
              {renderThreadList("work-pinned", groups.pinned, true)}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
      <SidebarGroup data-testid="work-projects-section">
        <div className="group/section-header mb-1 flex items-center justify-between pl-2 pr-1.5">
          <span className="text-xs font-medium text-sidebar-muted-foreground/80">Projects</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="New project"
                  className={WORK_SECTION_HEADER_ACTION_CLASS}
                  onClick={createProject}
                />
              }
            >
              <FolderPlusIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="right">New project</TooltipPopup>
          </Tooltip>
        </div>
        <SidebarMenu>{projectTree.map(renderProject)}</SidebarMenu>
        {props.repositoryRows}
        {projectTree.length === 0 && !props.hasRepositories ? (
          <div className="px-2 pt-2 text-center text-secondary-label text-xs">
            Create a project and drag chats into it
          </div>
        ) : null}
      </SidebarGroup>
      <SidebarGroup data-testid="work-chats-section" {...dropHandlers({ projectId: null })}>
        <div
          className={cn(
            "rounded-md transition-colors",
            isChatsDropTarget && "bg-sidebar-row-hover/60",
          )}
        >
          <div className="group/section-header mb-1 flex items-center justify-between pl-2 pr-1.5">
            <span className="text-xs font-medium text-sidebar-muted-foreground/80">Chats</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="New chat"
                    className={WORK_SECTION_HEADER_ACTION_CLASS}
                    onClick={(event) => createChat(null, { x: event.clientX, y: event.clientY })}
                  />
                }
              >
                <SquarePenIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="right">New chat</TooltipPopup>
            </Tooltip>
          </div>
          <SidebarMenu>
            <SidebarMenuItem>{renderThreadList("work-chats", groups.chats, true)}</SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarGroup>
    </>
  );
});

function WorkProjectNameInput(props: {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const settle = (commit: boolean) => {
    if (settledRef.current) return;
    settledRef.current = true;
    const value = inputRef.current?.value ?? "";
    if (commit && value.trim().length > 0) props.onCommit(value);
    else props.onCancel();
  };
  return (
    <input
      ref={inputRef}
      aria-label="Project name"
      className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none"
      defaultValue={props.initialName}
      onBlur={() => settle(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") settle(true);
        if (event.key === "Escape") settle(false);
      }}
    />
  );
}

const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const {
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateActionPending,
    handleDesktopUpdateButtonClick,
    projectSortOrder,
    threadSortOrder,
    threadPreviewCount,
    openAddProject,
    isManualProjectSorting,
    projectDnDSensors,
    projectCollisionDetection,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleNewThread,
    archiveThread,
    deleteThread,
    markThreadUnread,
    sortedProjects,
    expandedThreadListsByProject,
    activeRouteProjectKey,
    routeThreadKey,
    openPullRequestsInRightPanel,
    newThreadShortcutLabel,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    attachProjectListAutoAnimateRef,
    projectsLength,
    resolveLogicalProjectKey,
  } = props;
  const appMode = useAppMode();
  const isWorkMode = appMode !== "code";

  const handleProjectSortOrderChange = useCallback((sortOrder: SidebarProjectSortOrder) => {
    updateClientSettings({ sidebarProjectSortOrder: sortOrder });
  }, []);
  const handleThreadSortOrderChange = useCallback((sortOrder: SidebarThreadSortOrder) => {
    updateClientSettings({ sidebarThreadSortOrder: sortOrder });
  }, []);
  const handleThreadPreviewCountChange = useCallback((count: SidebarThreadPreviewCount) => {
    updateClientSettings({ sidebarThreadPreviewCount: count });
  }, []);

  // fork: agents — the Work sidebar follows the selected agent: Firstmate keeps
  // the Pinned, Projects, and Chats lists; any other agent shows only its tasks
  // and automations.
  const selectedAgent = useSelectedAgent();
  const showAgentSections = appMode === "work" && selectedAgent !== null;
  const showWorkLists =
    appMode !== "work" || selectedAgent === null || isFirstmateAgent(selectedAgent);
  const workRepositoryProjects = workRepositories(
    sortedProjects,
    new Set([...readFirstmateHomeProjectKeys(), ...readAgentHomeProjectKeys()]),
    (member) => scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
  );

  return (
    <SidebarContent
      fixedHeader={
        appMode === "work" ? (
          // fork: compact search — search now lives beside the titlebar history buttons.
          <SidebarGroup className="z-[1]">
            <AgentSwitcher />
          </SidebarGroup>
        ) : undefined
      }
    >
      {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
        <SidebarGroup>
          <Alert variant="warning">
            <TriangleAlertIcon />
            <AlertTitle>Intel build on Apple Silicon</AlertTitle>
            <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
            {desktopUpdateButtonAction !== "none" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={desktopUpdateButtonDisabled || desktopUpdateActionPending}
                  onClick={handleDesktopUpdateButtonClick}
                >
                  {desktopUpdateButtonAction === "download"
                    ? "Download ARM build"
                    : "Install ARM build"}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </SidebarGroup>
      ) : null}
      <LocalSecondaryStatus />
      {showAgentSections ? <AgentSidebarSections agent={selectedAgent} /> : null /* fork: agents */}
      {showAgentSections && showWorkLists ? (
        // The group's own padding insets the line; a margin on the line itself
        // would add to its full width and make the sidebar scroll sideways.
        <SidebarGroup className="mb-3">
          <Separator />
        </SidebarGroup> /* fork: agents */
      ) : null}
      {!showWorkLists ? null : isWorkMode ? (
        <SidebarWorkSections
          hasRepositories={workRepositoryProjects.length > 0}
          repositoryRows={
            <SidebarMenu data-testid="work-repositories">
              {workRepositoryProjects.map((project) => (
                <SidebarProjectListRow
                  key={project.projectKey}
                  project={project}
                  isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                  activeRouteThreadKey={
                    activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                  }
                  openPullRequestsInRightPanel={openPullRequestsInRightPanel}
                  newThreadShortcutLabel={newThreadShortcutLabel}
                  handleNewThread={handleNewThread}
                  archiveThread={archiveThread}
                  deleteThread={deleteThread}
                  markThreadUnread={markThreadUnread}
                  threadJumpLabelByKey={threadJumpLabelByKey}
                  attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                  expandThreadListForProject={expandThreadListForProject}
                  collapseThreadListForProject={collapseThreadListForProject}
                  dragInProgressRef={dragInProgressRef}
                  suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                  suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
                  isManualProjectSorting={false}
                  dragHandleProps={null}
                />
              ))}
            </SidebarMenu>
          }
          routeThreadKey={routeThreadKey}
          openPullRequestsInRightPanel={openPullRequestsInRightPanel}
          newThreadShortcutLabel={newThreadShortcutLabel}
          handleNewThread={handleNewThread}
          archiveThread={archiveThread}
          deleteThread={deleteThread}
          markThreadUnread={markThreadUnread}
          threadJumpLabelByKey={threadJumpLabelByKey}
          attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
          expandedThreadListsByProject={expandedThreadListsByProject}
          expandThreadListForProject={expandThreadListForProject}
          collapseThreadListForProject={collapseThreadListForProject}
          resolveLogicalProjectKey={resolveLogicalProjectKey}
        />
      ) : (
        <SidebarGroup>
          <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
            <span className="text-xs font-medium text-sidebar-muted-foreground/80">Projects</span>
            <div className="flex items-center gap-1">
              <ProjectSortMenu
                projectSortOrder={projectSortOrder}
                threadSortOrder={threadSortOrder}
                threadPreviewCount={threadPreviewCount}
                onProjectSortOrderChange={handleProjectSortOrderChange}
                onThreadSortOrderChange={handleThreadSortOrderChange}
                onThreadPreviewCountChange={handleThreadPreviewCountChange}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label="Add project"
                      data-testid="sidebar-add-project-trigger"
                      onClick={openAddProject}
                    />
                  }
                >
                  <FolderPlusIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="right">Add project</TooltipPopup>
              </Tooltip>
            </div>
          </div>

          {isManualProjectSorting ? (
            <DndContext
              sensors={projectDnDSensors}
              collisionDetection={projectCollisionDetection}
              modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
              onDragStart={handleProjectDragStart}
              onDragEnd={handleProjectDragEnd}
              onDragCancel={handleProjectDragCancel}
            >
              <SidebarMenu>
                <SortableContext
                  items={sortedProjects.map((project) => project.projectKey)}
                  strategy={verticalListSortingStrategy}
                >
                  {sortedProjects.map((project) => (
                    <SortableProjectItem key={project.projectKey} projectId={project.projectKey}>
                      {(dragHandleProps) => (
                        <SidebarProjectItem
                          project={project}
                          isThreadListExpanded={expandedThreadListsByProject.has(
                            project.projectKey,
                          )}
                          activeRouteThreadKey={
                            activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                          }
                          openPullRequestsInRightPanel={openPullRequestsInRightPanel}
                          newThreadShortcutLabel={newThreadShortcutLabel}
                          handleNewThread={handleNewThread}
                          archiveThread={archiveThread}
                          deleteThread={deleteThread}
                          markThreadUnread={markThreadUnread}
                          threadJumpLabelByKey={threadJumpLabelByKey}
                          attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                          expandThreadListForProject={expandThreadListForProject}
                          collapseThreadListForProject={collapseThreadListForProject}
                          dragInProgressRef={dragInProgressRef}
                          suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                          suppressProjectClickForContextMenuRef={
                            suppressProjectClickForContextMenuRef
                          }
                          isManualProjectSorting={isManualProjectSorting}
                          dragHandleProps={dragHandleProps}
                        />
                      )}
                    </SortableProjectItem>
                  ))}
                </SortableContext>
              </SidebarMenu>
            </DndContext>
          ) : (
            <SidebarMenu ref={attachProjectListAutoAnimateRef}>
              {sortedProjects.map((project) => (
                <SidebarProjectListRow
                  key={project.projectKey}
                  project={project}
                  isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                  activeRouteThreadKey={
                    activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                  }
                  openPullRequestsInRightPanel={openPullRequestsInRightPanel}
                  newThreadShortcutLabel={newThreadShortcutLabel}
                  handleNewThread={handleNewThread}
                  archiveThread={archiveThread}
                  deleteThread={deleteThread}
                  markThreadUnread={markThreadUnread}
                  threadJumpLabelByKey={threadJumpLabelByKey}
                  attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                  expandThreadListForProject={expandThreadListForProject}
                  collapseThreadListForProject={collapseThreadListForProject}
                  dragInProgressRef={dragInProgressRef}
                  suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                  suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
                  isManualProjectSorting={isManualProjectSorting}
                  dragHandleProps={null}
                />
              ))}
            </SidebarMenu>
          )}

          {projectsLength === 0 && (
            <div className="px-2 pt-4 text-center text-secondary-label text-xs">
              No projects yet
            </div>
          )}
        </SidebarGroup>
      )}
    </SidebarContent>
  );
});

function clearThreadSelectionOnOutsideMouseDown(event: globalThis.MouseEvent) {
  const selection = useThreadSelectionStore.getState();
  if (!selection.hasSelection()) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (shouldClearThreadSelectionOnMouseDown(target)) selection.clearSelection();
}

export default function LegacySidebar({ routeReveal }: { routeReveal: SidebarRouteReveal }) {
  const projects = useProjects();
  const sidebarThreads = useThreadShells();
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const navigate = useNavigate();
  const sidebarThreadSortOrder = useClientSettings((s) => s.sidebarThreadSortOrder);
  const sidebarProjectSortOrder = useClientSettings((s) => s.sidebarProjectSortOrder);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const sidebarThreadPreviewCount = useClientSettings((s) => s.sidebarThreadPreviewCount);
  const handleNewThread = useNewThreadHandler();
  const { archiveThread, deleteThread, markThreadUnread } = useThreadActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeTarget = useThreadRouteTarget();
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const routeTerminalOpen = useTerminalUiStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const openAddProjectCommandPalette = useCallback(
    () => openCommandPalette({ open: "add-project" }),
    [],
  );
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const desktopUpdateState = useDesktopUpdateState();
  const [desktopUpdateActionPending, setDesktopUpdateActionPending] = useState(false);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const shortcutModifiers = useShortcutModifierState();
  const terminalFocused = useTerminalFocus();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const desktopLocalEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => isDesktopLocalConnectionTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const wslEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => isWslConnectionTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);

  // Build a mapping from physical project key → logical project key for
  // cross-environment grouping.  Projects that share a repositoryIdentity
  // canonicalKey are treated as one logical project in the sidebar.
  const physicalToLogicalKey = useMemo(() => {
    return buildPhysicalToLogicalProjectKeyMap({
      projects: orderedProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
    });
  }, [orderedProjects, projectGroupingSettings, primaryEnvironmentId]);
  const projectPhysicalKeyByScopedRef = useMemo(
    () =>
      new Map(
        orderedProjects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          derivePhysicalProjectKey(project),
        ]),
      ),
    [orderedProjects],
  );

  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(() => {
    return buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      isDesktopLocalEnvironment: (environmentId) => desktopLocalEnvironmentIds.has(environmentId),
      isWslEnvironment: (environmentId) => wslEnvironmentIds.has(environmentId),
    });
  }, [
    environmentLabelById,
    desktopLocalEnvironmentIds,
    wslEnvironmentIds,
    orderedProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
  ]);

  const sidebarProjectByKey = useMemo(
    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),
    [sidebarProjects],
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  // Resolve the active route's project key to a logical key so it matches the
  // sidebar's grouped project entries.
  const activeRouteProjectKey = useMemo(() => {
    if (!routeThreadKey) {
      return null;
    }
    const activeThread = sidebarThreadByKey.get(routeThreadKey);
    if (!activeThread) return null;
    const physicalKey =
      projectPhysicalKeyByScopedRef.get(
        scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId)),
      ) ?? scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId));
    return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
  }, [routeThreadKey, sidebarThreadByKey, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);

  // Group threads by logical project key so all threads from grouped projects
  // are displayed together.
  const threadsByProjectKey = useMemo(() => {
    const next = new Map<string, SidebarThreadSummary[]>();
    for (const thread of sidebarThreads) {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
      const existing = next.get(logicalKey);
      if (existing) {
        existing.push(thread);
      } else {
        next.set(logicalKey, [thread]);
      }
    }
    return next;
  }, [sidebarThreads, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);
  const resolveLogicalProjectKey = useCallback(
    (thread: SidebarThreadSummary) => {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
    },
    [physicalToLogicalKey, projectPhysicalKeyByScopedRef],
  );
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      terminalFocus: isTerminalFocused(),
      terminalOpen: routeTerminalOpen,
      modelPickerOpen: isModelPickerOpen(),
    }),
    [routeTerminalOpen],
  );
  const newThreadShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {
        terminalFocus: false,
        terminalOpen: false,
      },
    }),
    [platform],
  );
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.newLocal", newThreadShortcutLabelOptions) ??
    shortcutLabelForCommand(keybindings, "chat.new", newThreadShortcutLabelOptions);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, navigate, setOpenMobile, setSelectionAnchor],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = sidebarProjects.find((project) => project.projectKey === active.id);
      const overProject = sidebarProjects.find((project) => project.projectKey === over.id);
      if (!activeProject || !overProject) return;
      const activeMemberKeys = activeProject.memberProjects.map(
        (member) => member.physicalProjectKey,
      );
      const overMemberKeys = overProject.memberProjects.map((member) => member.physicalProjectKey);
      reorderProjects(orderedProjects.map(getProjectOrderKey), activeMemberKeys, overMemberKeys);
    },
    [orderedProjects, sidebarProjectSortOrder, reorderProjects, sidebarProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  }, []);

  const visibleThreads = useMemo(
    () => filterSidebarV2VisibleThreads(sidebarThreads, null),
    [sidebarThreads],
  );
  const sortedProjects = useMemo(() => {
    const sortableProjects = sidebarProjects.map((project) => ({
      ...project,
      id: project.projectKey,
    }));
    const sortableThreads = visibleThreads.map((thread) => {
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return {
        ...thread,
        projectId: (physicalToLogicalKey.get(physicalKey) ?? physicalKey) as ProjectId,
      };
    });
    return sortProjectsForSidebar(
      sortableProjects,
      sortableThreads,
      sidebarProjectSortOrder,
    ).flatMap((project) => {
      const resolvedProject = sidebarProjectByKey.get(project.id);
      return resolvedProject ? [resolvedProject] : [];
    });
  }, [
    sidebarProjectSortOrder,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    sidebarProjectByKey,
    sidebarProjects,
    visibleThreads,
  ]);
  const isManualProjectSorting = sidebarProjectSortOrder === "manual";
  const visibleSidebarThreadKeys = useMemo(
    () =>
      sortedProjects.flatMap((project) => {
        const projectThreads = sortThreads(
          filterSidebarV2VisibleThreads(threadsByProjectKey.get(project.projectKey) ?? [], null),
          sidebarThreadSortOrder,
        );
        const projectExpanded = resolveProjectExpanded(
          projectExpandedById,
          projectExpansionPreferenceKeys(project),
        );
        const activeThreadKey = routeThreadKey ?? undefined;
        const pinnedCollapsedThread =
          !projectExpanded && activeThreadKey
            ? (projectThreads.find(
                (thread) =>
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                  activeThreadKey,
              ) ?? null)
            : null;
        const shouldShowThreadPanel = projectExpanded || pinnedCollapsedThread !== null;
        if (!shouldShowThreadPanel) {
          return [];
        }
        const isThreadListExpanded = expandedThreadListsByProject.has(project.projectKey);
        const hasOverflowingThreads = projectThreads.some(
          (thread, index) =>
            index >= sidebarThreadPreviewCount &&
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) !== activeThreadKey,
        );
        const previewThreads =
          isThreadListExpanded || !hasOverflowingThreads
            ? projectThreads
            : projectThreads.slice(0, sidebarThreadPreviewCount);
        if (pinnedCollapsedThread) {
          return [
            scopedThreadKey(
              scopeThreadRef(pinnedCollapsedThread.environmentId, pinnedCollapsedThread.id),
            ),
          ];
        }
        return projectThreads.flatMap((thread, index) => {
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return index < previewThreads.length || threadKey === activeThreadKey ? [threadKey] : [];
        });
      }),
    [
      sidebarThreadSortOrder,
      sidebarThreadPreviewCount,
      expandedThreadListsByProject,
      projectExpandedById,
      routeThreadKey,
      sortedProjects,
      threadsByProjectKey,
    ],
  );
  const revealActiveRow = useActiveRowReveal(routeReveal, routeThreadKey);
  const threadJumpCommandByKey = useMemo(() => {
    const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadKey] of visibleSidebarThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadKey, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadKeys]);
  const threadJumpThreadKeys = useMemo(
    () => [...threadJumpCommandByKey.keys()],
    [threadJumpCommandByKey],
  );
  const sidebarShortcutContext = {
    terminalFocus: terminalFocused,
    terminalOpen: routeTerminalOpen,
    modelPickerOpen: isModelPickerOpen(),
  };
  const threadJumpLabelByKey = useMemo(
    () =>
      buildThreadJumpLabelMap({
        keybindings,
        platform,
        terminalOpen: sidebarShortcutContext.terminalOpen,
        threadJumpCommandByKey,
      }),
    [keybindings, platform, sidebarShortcutContext.terminalOpen, threadJumpCommandByKey],
  );
  const shouldShowThreadJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform,
      context: sidebarShortcutContext,
    },
  );
  const showThreadJumpHints = useThreadJumpHintsVisible(shouldShowThreadJumpHintsNow);
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByKey
    : EMPTY_THREAD_JUMP_LABELS;
  const orderedSidebarThreadKeys = visibleSidebarThreadKeys;
  const prewarmedSidebarThreadKeys = useMemo(
    () => getSidebarThreadIdsToPrewarm(visibleSidebarThreadKeys),
    [visibleSidebarThreadKeys],
  );
  const prewarmedSidebarThreadRefs = useMemo(
    () =>
      prewarmedSidebarThreadKeys.flatMap((threadKey) => {
        const ref = parseScopedThreadKey(threadKey);
        return ref ? [ref] : [];
      }),
    [prewarmedSidebarThreadKeys],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcutContext = getCurrentSidebarShortcutContext();

      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (traversalDirection !== null) {
        const targetThreadKey = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadKeys,
          currentThreadId: routeThreadKey,
          direction: traversalDirection,
        });
        if (!targetThreadKey) {
          return;
        }
        const targetThread = sidebarThreadByKey.get(targetThreadKey);
        if (!targetThread) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadKey = threadJumpThreadKeys[jumpIndex];
      if (!targetThreadKey) {
        return;
      }
      const targetThread = sidebarThreadByKey.get(targetThreadKey);
      if (!targetThread) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
    };

    window.addEventListener("keydown", onWindowKeyDown);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    getCurrentSidebarShortcutContext,
    keybindings,
    navigateToThread,
    orderedSidebarThreadKeys,
    platform,
    routeThreadKey,
    sidebarThreadByKey,
    threadJumpThreadKeys,
  ]);
  // A window listener whose lifetime is the sidebar's: no element owns outside clicks.
  useEffect(() => {
    window.addEventListener("mousedown", clearThreadSelectionOnOutsideMouseDown);
    return () => window.removeEventListener("mousedown", clearThreadSelectionOnOutsideMouseDown);
  }, []);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const handleDesktopUpdateButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (
      desktopUpdateButtonDisabled ||
      desktopUpdateButtonAction === "none" ||
      desktopUpdateActionPending
    ) {
      return;
    }

    setDesktopUpdateActionPending(true);

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            showDesktopUpdateDownloadedToast(bridge, result.state);
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not download update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start update download",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setDesktopUpdateActionPending(false));
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
        );
      } catch (error) {
        setDesktopUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setDesktopUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "An unexpected error occurred.",
            }),
          );
        })
        .finally(() => setDesktopUpdateActionPending(false));
    }
  }, [
    desktopUpdateActionPending,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateState,
  ]);

  const expandThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectKey)) return current;
      const next = new Set(current);
      next.add(projectKey);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current);
      next.delete(projectKey);
      return next;
    });
  }, []);

  return (
    <RevealActiveRowContext value={revealActiveRow}>
      {prewarmedSidebarThreadRefs.map((threadRef) => (
        <SidebarThreadDetailPrewarmer key={scopedThreadKey(threadRef)} threadRef={threadRef} />
      ))}
      <SidebarChromeHeader isElectron={isElectron} />

      <SidebarProjectsContent
        showArm64IntelBuildWarning={showArm64IntelBuildWarning}
        arm64IntelBuildWarningDescription={arm64IntelBuildWarningDescription}
        desktopUpdateButtonAction={desktopUpdateButtonAction}
        desktopUpdateButtonDisabled={desktopUpdateButtonDisabled}
        desktopUpdateActionPending={desktopUpdateActionPending}
        handleDesktopUpdateButtonClick={handleDesktopUpdateButtonClick}
        projectSortOrder={sidebarProjectSortOrder}
        threadSortOrder={sidebarThreadSortOrder}
        threadPreviewCount={sidebarThreadPreviewCount}
        openAddProject={openAddProjectCommandPalette}
        isManualProjectSorting={isManualProjectSorting}
        projectDnDSensors={projectDnDSensors}
        projectCollisionDetection={projectCollisionDetection}
        handleProjectDragStart={handleProjectDragStart}
        handleProjectDragEnd={handleProjectDragEnd}
        handleProjectDragCancel={handleProjectDragCancel}
        handleNewThread={handleNewThread}
        archiveThread={archiveThread}
        deleteThread={deleteThread}
        markThreadUnread={markThreadUnread}
        sortedProjects={sortedProjects}
        expandedThreadListsByProject={expandedThreadListsByProject}
        activeRouteProjectKey={activeRouteProjectKey}
        routeThreadKey={routeThreadKey}
        openPullRequestsInRightPanel={routeThreadRef !== null}
        newThreadShortcutLabel={newThreadShortcutLabel}
        threadJumpLabelByKey={visibleThreadJumpLabelByKey}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
        dragInProgressRef={dragInProgressRef}
        suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
        suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
        attachProjectListAutoAnimateRef={attachProjectListAutoAnimateRef}
        projectsLength={projects.length}
        resolveLogicalProjectKey={resolveLogicalProjectKey}
      />
      <SidebarChromeFooter showUndoNotice />
    </RevealActiveRowContext>
  );
}
