// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, FirstmateTaskId, ThreadId, type FirstmateTask } from "@t3tools/contracts";
import { AgentTaskTree } from "./AgentTaskTree";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), Link: "a" }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("./WorkSidebarShortcuts", () => ({ useWorkSidebarShortcut: () => {} }));
vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));

const task: FirstmateTask = {
  id: FirstmateTaskId.make("review-task"),
  title: "Review the release",
  status: "in_review",
  state: "waiting",
  nextActor: "user",
  intent: "Review the release",
  nextStep: null,
  workerThreadId: null,
  note: "",
  wakeAt: null,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
  closedAt: null,
  definitionOfDone: "Approved",
  links: [],
  artifacts: [],
  closeEvidence: null,
};
afterEach(() => vi.unstubAllGlobals());

it("shows one lifecycle row with leading attention, and removes attention when the user is no longer next", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (value: FirstmateTask) =>
    root.render(
      <AgentTaskTree
        environmentId={EnvironmentId.make("test")}
        coordinatorThreadId={ThreadId.make("coordinator")}
        tasks={[value]}
        activeRouteKey={null}
      />,
    );
  try {
    await act(() => render(task));
    expect(container.querySelector('section[aria-label="Needs you"]')).toBeNull();
    expect(container.querySelectorAll("[data-task-id]")).toHaveLength(1);
    const section = container.querySelector('section[aria-label="In review"]');
    expect(section?.textContent).toContain(task.title);
    const attention = section?.querySelector('[role="img"][aria-label="Needs your input"]');
    expect(attention).not.toBeNull();
    expect(attention?.parentElement?.firstElementChild).toBe(attention);

    await act(() => render({ ...task, nextActor: "worker" }));
    expect(container.querySelector('[aria-label="Needs your input"]')).toBeNull();
    expect(container.querySelectorAll("[data-task-id]")).toHaveLength(1);
    expect(container.textContent).toContain(task.title);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
