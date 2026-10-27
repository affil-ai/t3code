// @vitest-environment jsdom
import type { FirstmateTaskId, ScopedThreadRef } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ open }),
  },
}));

import { useAutoOpenWorkerTaskDetails } from "./workerTaskDetailsAutoOpen";

const threadRef: ScopedThreadRef = {
  environmentId: "env-1" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

function Probe({
  task,
  shouldUsePlanSidebarSheet,
}: {
  readonly task: { readonly id: FirstmateTaskId; readonly revision: number } | null;
  readonly shouldUsePlanSidebarSheet: boolean;
}) {
  useAutoOpenWorkerTaskDetails(threadRef, task?.id ?? null, shouldUsePlanSidebarSheet);
  return null;
}

let root: Root | null = null;

async function render(
  task: { readonly id: FirstmateTaskId; readonly revision: number } | null,
  shouldUsePlanSidebarSheet: boolean,
) {
  await act(() => {
    const next = <Probe task={task} shouldUsePlanSidebarSheet={shouldUsePlanSidebarSheet} />;
    root ??= createRoot(document.createElement("div"));
    root.render(next);
  });
}

beforeEach(() => {
  open.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => root?.unmount());
  root = null;
});

describe("useAutoOpenWorkerTaskDetails", () => {
  it("does not open Details when the right panel is a narrow-layout sheet", async () => {
    await render({ id: "task-1" as FirstmateTaskId, revision: 1 }, true);

    expect(open).not.toHaveBeenCalled();
  });

  it("does not open Details after a narrow-to-wide resize", async () => {
    const task = { id: "task-1" as FirstmateTaskId, revision: 1 };
    await render(task, true);
    await render(task, false);

    expect(open).not.toHaveBeenCalled();
  });

  it("does not reopen Details when the task object updates", async () => {
    const task = { id: "task-1" as FirstmateTaskId, revision: 1 };
    await render(task, false);
    expect(open).toHaveBeenCalledTimes(1);

    open.mockClear();
    await render({ ...task, revision: 2 }, false);

    expect(open).not.toHaveBeenCalled();
  });
});
