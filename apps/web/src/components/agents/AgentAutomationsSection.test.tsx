// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AgentAutomationsSection } from "./AgentAutomationsSection";

vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({ projectId: "project" }),
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    error: null,
    data: {
      tasks: [
        {
          id: "automation",
          threadId: "coordinator",
          title: "Review updates",
          enabled: true,
          nextRunAt: null,
          lastRunStatus: "never",
          schedule: { type: "interval", everyMs: 60000 },
        },
      ],
    },
  }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { scheduledTasksLive: () => ({}) },
}));
vi.mock("../settings/ScheduledTasksSettings", () => ({
  scheduleLabel: () => "Every minute",
  ScheduledRelativeLabel: () => null,
  ScheduledTaskEditorDialog: () => <div role="dialog">Automation editor</div>,
}));
vi.mock("../settings/SettingsScopeContext", () => ({
  SettingsScopeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

it("collapses and expands the list while keeping the count and creation action available", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() =>
      root.render(
        <AgentAutomationsSection
          environmentId={EnvironmentId.make("test")}
          threadId={ThreadId.make("coordinator")}
        />,
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>("button[aria-controls]")!;
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(toggle.textContent).toContain("Automations");
    expect(toggle.textContent).toContain("1");
    expect(panel.textContent).toContain("Review updates");
    expect(panel.hidden).toBe(false);
    await act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hidden).toBe(true);
    await act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="New automation"]')!.click(),
    );
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Automation editor");
    expect(panel.hidden).toBe(true);
    await act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
  } finally {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
