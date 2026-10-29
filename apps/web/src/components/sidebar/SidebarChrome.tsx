import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  ChevronDownIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { SidebarHeaderActions } from "../work/SidebarHeaderActions"; // fork: compact search

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { T3Wordmark } from "../T3Wordmark";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { type AppMode, useAppMode, useIsWorkMode, useWorkModeStore } from "../../workModeStore";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto z-10 translate-y-0"
          aria-label="Toggle main sidebar"
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand onBackdrop={backdropVariant !== null} />
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
      <SidebarHeaderActions /> {/* fork: compact search */}
    </div>
  );
});

// fork: the brand menu switches between Code and Work.
const APP_MODE_OPTIONS = [
  { mode: "code", label: "Code", description: "Projects, terminals, and Git" },
  { mode: "work", label: "Work", description: "Projects and chats" },
] as const satisfies ReadonlyArray<{
  mode: AppMode;
  label: string;
  description: string;
}>;

export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex">
        <SidebarBrandMark onBackdrop={false} />
      </div>
    </div>
  );
}

/** The brand also selects Code or Work. */
function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  const mode = useAppMode();
  const setMode = useWorkModeStore((state) => state.setMode);
  const current = APP_MODE_OPTIONS.find((option) => option.mode === mode) ?? APP_MODE_OPTIONS[0];
  return (
    <Menu>
      <MenuTrigger
        aria-label={`T3 ${current.label}. Switch mode`}
        data-app-mode={mode}
        render={
          <button
            type="button"
            className={cn(
              "group/brand relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 cursor-pointer items-center gap-1 overflow-hidden rounded-md px-1 outline-hidden ring-ring [-webkit-app-region:no-drag] hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[popup-open]:bg-sidebar-row-hover md:flex",
              onBackdrop ? "text-white hover:bg-white/15" : "text-foreground",
            )}
          />
        }
      >
        <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
          <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
          <span
            className={cn(
              // Padding keeps descenders (the g in Agents) inside the truncation clip.
              "truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1",
              onBackdrop ? "text-white/70" : "text-muted-foreground",
            )}
          >
            {current.label}
          </span>
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 opacity-50 group-hover/brand:opacity-90",
            onBackdrop ? "text-white/70" : "text-muted-foreground",
          )}
        />
      </MenuTrigger>
      <MenuPopup align="start" className="w-60">
        {APP_MODE_OPTIONS.map((option) => (
          <MenuItem key={option.mode} onClick={() => setMode(option.mode)}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{`T3 ${option.label}`}</span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </span>
            {option.mode === mode ? <CheckIcon className="size-4 shrink-0" /> : null}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function SidebarBrandMark({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1 text-sm font-medium tracking-tight">
      <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
      <span
        className={cn(
          "truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1",
          onBackdrop ? "text-white/70" : "text-muted-foreground",
        )}
      >
        Code
      </span>
    </span>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const isWorkMode = useIsWorkMode(); // fork: Work mode hides pull requests
  const pullRequestsSupported = usePullRequestsSupported() && !isWorkMode; // fork
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };

  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };

  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter({
  showUndoNotice = false,
}: {
  showUndoNotice?: boolean;
}) {
  return (
    <SidebarFooter>
      {showUndoNotice ? <SidebarThreadUndoNotice /> : null}
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
