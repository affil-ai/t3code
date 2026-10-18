// @vitest-environment jsdom

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type AgentProfile, type FirstmateTask } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "~/rightPanelStore";
import { useSelectedAgentStore } from "~/selectedAgentStore";
import { SidebarProvider, useSidebar } from "../ui/sidebar";
import { AgentSwitcher } from "./AgentSwitcher";
import { AgentTaskTree } from "./AgentTaskTree";

const mocks = vi.hoisted(() => ({
  mobile: true,
  navigate: vi.fn(),
  workerShell: null as { updatedAt: string } | null,
  researchTasks: [] as Array<{ state: string; nextActor: string; workerThreadId: string | null }>,
  firstmateAppearance: { name: "Firstmate", icon: "compass" } as {
    name: string;
    icon: string;
  } | null,
}));
const environmentId = EnvironmentId.make("test");
const agents = [
  { id: "firstmate", name: "Firstmate", coordinatorThreadId: "firstmate-chat" },
  { id: "research", name: "Research", coordinatorThreadId: "research-chat" },
].map((agent) => ({
  ...agent,
  coordinatorThreadId: ThreadId.make(agent.coordinatorThreadId),
  role: "Your coordinator",
  icon: agent.id === "firstmate" ? "compass" : "bot",
  color: "blue",
})) as AgentProfile[];
const firstmate = agents[0]!;
const research = agents[1]!;

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => null,
  Link: ({
    children,
    params,
    onClick,
    ...props
  }: ComponentProps<"a"> & { params: { environmentId: string; threadId: string } }) => (
    <a
      {...props}
      href={`/${params.environmentId}/${params.threadId}`}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
        mocks.navigate({ params });
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("~/hooks/useMediaQuery", () => ({ useIsMobile: () => mocks.mobile }));
vi.mock("~/state/agents", () => ({
  useAgentsHome: () => ({ environmentId, agents }),
  useAgentByThreadKey: () => new Map(),
  useAgentTasks: () => ({ data: { tasks: mocks.researchTasks } }),
}));
vi.mock("~/state/firstmate", () => ({
  useFirstmateHome: () =>
    mocks.firstmateAppearance === null
      ? null
      : {
          environmentId,
          snapshot: { ...firstmate, ...mocks.firstmateAppearance, tasks: [] },
        },
}));
vi.mock("~/state/entities", () => ({ useThreadShell: () => mocks.workerShell }));
vi.mock("../Sidebar.logic", () => ({ resolveThreadStatusPill: () => null }));
vi.mock("../firstmate/firstmateModel", () => ({ useFirstmateModelSelection: () => null }));
vi.mock("./agentCommands", () => ({ useAgentCommands: () => ({ pending: null }) }));
vi.mock("./AgentDialog", () => ({ AgentDialog: () => null }));
vi.mock("../firstmate/FirstmateAppearanceDialog", () => ({
  FirstmateAppearanceDialog: () => null,
}));

let root: Root;
let container: HTMLDivElement;

function SidebarState({ children }: { children: ReactNode }) {
  const { isMobile, open, openMobile, setOpenMobile } = useSidebar();
  return (
    <>
      <button onClick={() => setOpenMobile(true)}>Open sidebar</button>
      <output data-testid="sidebar-open">{String(isMobile ? openMobile : open)}</output>
      {children}
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  mocks.mobile = true;
  mocks.navigate.mockReset();
  mocks.workerShell = null;
  mocks.firstmateAppearance = { name: "Firstmate", icon: "compass" };
  useSelectedAgentStore.setState({
    selectedAgentId: null,
    preferCustomAgent: false,
    agentOrder: [],
  });
  useRightPanelStore.setState({ byThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function renderSwitcher() {
  await act(() =>
    root.render(
      <SidebarProvider>
        <SidebarState>
          <AgentSwitcher />
        </SidebarState>
      </SidebarProvider>,
    ),
  );
  await click(container.querySelector("button")!);
}

async function click(element: Element) {
  await act(() =>
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
}

async function pointer(element: Element, type: string, pointerType: string) {
  const event = new MouseEvent(type, { bubbles: true, button: 0 });
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: 1 },
  });
  await act(() => element.dispatchEvent(event));
}

describe("agent switcher navigation", () => {
  it("renders scrollable agent tabs above the existing selector and switches immediately", async () => {
    await renderSwitcher();

    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Firstmate", "Research"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(
      container.querySelector('[data-testid="agent-tabs"]')?.parentElement?.nextElementSibling,
    ).not.toBeNull();

    await click(tabs[1]!);

    expect(useSelectedAgentStore.getState().selectedAgentId).toBe(research.id);
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: research.coordinatorThreadId },
    });
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      "Research",
    );
  });

  it("badges a tab with the agent's tasks that need the user", async () => {
    mocks.researchTasks = [
      { state: "open", nextActor: "user", workerThreadId: "w1" },
      { state: "waiting", nextActor: "user", workerThreadId: "w2" },
      { state: "open", nextActor: "worker", workerThreadId: "w3" },
    ];
    try {
      await renderSwitcher();
      const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
      expect(tabs[1]?.getAttribute("aria-label")).toBe("Switch to Research, 2 need you");
      expect(tabs[1]?.querySelector('[data-testid="agent-tab-needs-you"]')?.textContent).toBe("2");
      expect(tabs[0]?.getAttribute("aria-label")).toBe("Switch to Firstmate");
      expect(tabs[0]?.querySelector('[data-testid="agent-tab-needs-you"]')).toBeNull();
    } finally {
      mocks.researchTasks = [];
    }
  });

  it("shows the tabs in the saved order and keeps a click switching agents", async () => {
    useSelectedAgentStore.setState({ agentOrder: [research.id] });
    await renderSwitcher();

    const tabs = [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Research", "Firstmate"]);
    expect(tabs[0]?.getAttribute("aria-roledescription")).toBe("draggable tab");

    await click(tabs[0]!);

    expect(useSelectedAgentStore.getState().selectedAgentId).toBe(research.id);
  });

  it.each([
    { appearance: { name: "Captain", icon: "crown" }, name: "Captain", icon: "crown" },
    { appearance: null, name: "Firstmate", icon: "compass" },
  ])(
    "keeps Firstmate's own name and icon when another agent is selected ($name)",
    async ({ appearance, name, icon }) => {
      mocks.firstmateAppearance = appearance;
      useSelectedAgentStore.setState({ selectedAgentId: research.id });
      await renderSwitcher();
      await click(container.querySelector('[aria-label="Switch agent"]')!);
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      const firstmateItem = items[0]!;
      const researchItem = items[1]!;
      expect(firstmateItem.textContent).toBe(`${name}Your coordinator`);
      expect(firstmateItem.querySelector(`svg.lucide-${icon}`)).not.toBeNull();
      expect(firstmateItem.querySelector("svg.lucide-bot")).toBeNull();
      expect(researchItem.textContent).toBe("ResearchYour coordinator");
      expect(researchItem.querySelector("svg.lucide-bot")).not.toBeNull();
      await click(firstmateItem);
      expect(useSelectedAgentStore.getState().selectedAgentId).toBeNull();
      expect(mocks.navigate).toHaveBeenLastCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: firstmate.coordinatorThreadId },
      });
      expect(container.querySelector("output")?.textContent).toBe("false");
    },
  );

  it("still opens on mouse hover on desktop", async () => {
    mocks.mobile = false;
    await renderSwitcher();
    const trigger = container.querySelector('[aria-label="Switch agent"]')!;
    await pointer(trigger, "pointerover", "mouse");
    await act(() => trigger.dispatchEvent(new MouseEvent("mouseenter")));
    await act(() => trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    await act(() => trigger.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("does not hover-open on a touch contact before the tap", async () => {
    await renderSwitcher();
    const trigger = container.querySelector('[aria-label="Switch agent"]')!;
    await pointer(trigger, "pointerover", "touch");
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await click(trigger);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await pointer(trigger, "pointerout", "touch");
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await click(trigger);
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("puts deployment first and backlog last, with worker age instead of descriptions", async () => {
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
    mocks.workerShell = { updatedAt: "2026-10-18T10:00:00Z" };
    const tasks = ["backlog", "in_progress", "ready_for_deployment"].map((status) => ({
      id: status,
      title: status,
      status,
      state: "open",
      nextActor: "user",
      intent: "Description should not appear",
      nextStep: "Next step should not appear",
      updatedAt: "2026-10-18T11:59:00Z",
      workerThreadId: ThreadId.make("worker-chat"),
    })) as FirstmateTask[];
    await act(() =>
      root.render(
        <SidebarProvider>
          <AgentTaskTree
            environmentId={environmentId}
            coordinatorThreadId={firstmate.coordinatorThreadId!}
            tasks={tasks}
            activeRouteKey={null}
          />
        </SidebarProvider>,
      ),
    );
    const sections = [...container.querySelectorAll("section")];
    expect(sections[0]?.getAttribute("aria-label")).toBe("Ready for deployment");
    const backlog = sections.at(-1)!;
    expect(backlog.getAttribute("aria-label")).toBe("Backlog");
    expect(backlog.textContent).toContain("Last active 2h ago");
    expect(backlog.textContent).not.toContain("Description should not appear");
    expect(backlog.textContent).not.toContain("Next step should not appear");
    await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000));
    expect(backlog.textContent).toContain("Last active 3h ago");
  });

  it.each(["worker", "coordinator"] as const)(
    "closes the mobile sidebar when a %s task chat is selected",
    async (nextActor) => {
      const task = {
        id: "task",
        title: "Investigate",
        intent: "Find the cause",
        state: "open",
        nextActor,
        nextStep: "Read the code",
        workerThreadId: ThreadId.make("worker-chat"),
      } as FirstmateTask;
      await act(() =>
        root.render(
          <SidebarProvider>
            <SidebarState>
              <AgentTaskTree
                environmentId={environmentId}
                coordinatorThreadId={firstmate.coordinatorThreadId!}
                tasks={[task]}
                activeRouteKey={null}
              />
            </SidebarState>
          </SidebarProvider>,
        ),
      );
      await click(container.querySelector("button")!);
      await click(
        container.querySelector(
          nextActor === "worker" ? "a" : '[data-testid="planning-task-card"]',
        )!,
      );
      expect(mocks.navigate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: { environmentId, threadId: "worker-chat" },
        }),
      );
      expect(container.querySelector("output")?.textContent).toBe("false");
    },
  );

  it("selects an agent, closes the mobile sidebar, and keeps its saved panel closed", async () => {
    const ref = scopeThreadRef(environmentId, research.coordinatorThreadId!);
    useRightPanelStore.getState().open(ref, "firstmate");
    await renderSwitcher();
    await click(container.querySelector('[aria-label="Switch agent"]')!);
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((element) =>
      element.textContent?.includes("Research"),
    )!;
    await click(item);
    expect(useSelectedAgentStore.getState().selectedAgentId).toBe(research.id);
    expect(mocks.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: research.coordinatorThreadId },
    });
    expect(container.querySelector("output")?.textContent).toBe("false");
    expect(useRightPanelStore.getState().byThreadKey["test:research-chat"]?.isOpen).toBe(false);
  });

  it.each([true, false])(
    "opens the selected agent's chat without its panel (mobile=%s)",
    async (mobile) => {
      mocks.mobile = mobile;
      const ref = scopeThreadRef(environmentId, firstmate.coordinatorThreadId!);
      useRightPanelStore.getState().open(ref, "firstmate");
      await renderSwitcher();
      await click(container.querySelector("a")!);
      expect(mocks.navigate).toHaveBeenCalled();
      expect(container.querySelector("output")?.textContent).toBe(String(!mobile));
      expect(useRightPanelStore.getState().byThreadKey["test:firstmate-chat"]?.isOpen).toBe(false);
      expect(useRightPanelStore.getState().byThreadKey["test:firstmate-chat"]?.surfaces).toEqual([
        { id: "firstmate", kind: "firstmate" },
      ]);
    },
  );
});
