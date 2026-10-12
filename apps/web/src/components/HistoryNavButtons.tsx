import type { RouterHistory } from "@tanstack/react-router";
import { useLocation, useRouter } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The browser does not expose whether a forward entry exists, so track the end
 * of this window's history: a push makes the new entry the last one, and
 * back/forward/go only move within the existing entries.
 */
const historyEnds = new WeakMap<RouterHistory, { end: number; listeners: Set<() => void> }>();

function historyEnd(history: RouterHistory) {
  let entry = historyEnds.get(history);
  if (!entry) {
    const tracked = {
      end: history.location.state.__TSR_index ?? 0,
      listeners: new Set<() => void>(),
    };
    history.subscribe(({ location, action }) => {
      const index = location.state.__TSR_index ?? 0;
      const end = action.type === "PUSH" ? index : Math.max(tracked.end, index);
      if (end === tracked.end) return;
      tracked.end = end;
      for (const listener of tracked.listeners) listener();
    });
    historyEnds.set(history, tracked);
    entry = tracked;
  }
  return entry;
}

const BUTTON_CLASS =
  "pointer-events-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-icon-muted outline-hidden ring-ring [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-icon-muted [&_svg]:size-4";

/** Back and forward through this window's navigation history. */
export function HistoryNavButtons({ className }: { className?: string }) {
  const router = useRouter();
  const tracked = historyEnd(router.history);
  const end = useSyncExternalStore(
    (listener) => {
      tracked.listeners.add(listener);
      return () => tracked.listeners.delete(listener);
    },
    () => tracked.end,
  );
  const index = useLocation({ select: (location) => location.state.__TSR_index ?? 0 });
  const canGoBack = index > 0;
  const canGoForward = index < end;

  return (
    <div className={cn("flex items-center gap-0.5", className)} data-history-nav="">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Go back"
              className={BUTTON_CLASS}
              disabled={!canGoBack}
              onClick={() => router.history.back()}
            />
          }
        >
          <ChevronLeftIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Back</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label="Go forward"
              className={BUTTON_CLASS}
              disabled={!canGoForward}
              onClick={() => router.history.forward()}
            />
          }
        >
          <ChevronRightIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Forward</TooltipPopup>
      </Tooltip>
    </div>
  );
}
