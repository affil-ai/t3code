import { EnvironmentId, FirstmateTaskId, ThreadId, type FirstmateTask } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  pendingSidebarRouteReveal,
  type SidebarRouteReveal,
  SidebarRouteRevealContext,
} from "../sidebar/routeReveal";
import { AgentTaskTree } from "./AgentTaskTree";

vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: () => {} }),
}));
vi.mock("./WorkSidebarShortcuts", () => ({ useWorkSidebarShortcut: () => {} }));
vi.mock("~/state/entities", () => ({ useThreadShell: () => null }));

const task: FirstmateTask = {
  id: FirstmateTaskId.make("worker-task"),
  title: "Ship the fix",
  status: "in_progress",
  state: "open",
  nextActor: "worker",
  intent: "Ship the fix",
  nextStep: null,
  workerThreadId: ThreadId.make("worker"),
  note: "",
  wakeAt: null,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
  closedAt: null,
  definitionOfDone: "Merged",
  links: [],
  artifacts: [],
  closeEvidence: null,
};

it("opens a worker thread without asking the sidebar to reveal its project row", async () => {
  const reveal: SidebarRouteReveal = { observedKey: "test:coordinator", pendingKey: null };
  await using screen = await render(
    <SidebarRouteRevealContext value={reveal}>
      <AgentTaskTree
        environmentId={EnvironmentId.make("test")}
        coordinatorThreadId={ThreadId.make("coordinator")}
        tasks={[task]}
        activeRouteKey="test:coordinator"
      />
    </SidebarRouteRevealContext>,
    { router: "/test/coordinator" },
  );
  await userEvent.click(screen.getByRole("link", { name: /Ship the fix/ }));
  expect(pendingSidebarRouteReveal(reveal, "test:worker")).toBeNull();
});
