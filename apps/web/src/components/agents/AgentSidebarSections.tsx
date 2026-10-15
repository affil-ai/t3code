/**
 * The selected agent's part of the Work sidebar, under its row: open tasks
 * (a task with a worker opens the worker's chat) and automations. Firstmate's
 * board comes from its own stream, any other agent's from `agents.tasks`.
 * The sections are absent until the agent has a chat.
 */
import { type AgentProfile, FIRSTMATE_AGENT_ID } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";

import { useAgentTasks } from "~/state/agents";
import { useFirstmateHome } from "~/state/firstmate";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { SidebarGroup } from "../ui/sidebar";
import { AgentAutomationsSection } from "./AgentAutomationsSection";
import { AgentTaskTree } from "./AgentTaskTree";

export function AgentSidebarSections({ agent }: { readonly agent: AgentProfile }) {
  const routeKey = useParams({
    strict: false,
    select: (params) => {
      const ref = resolveThreadRouteRef(params);
      return ref ? `${ref.environmentId}:${ref.threadId}` : null;
    },
  });
  const firstmate = agent.id === FIRSTMATE_AGENT_ID;
  const firstmateHome = useFirstmateHome();
  const agentQuery = useAgentTasks(
    firstmate || firstmateHome === null ? null : firstmateHome.environmentId,
    firstmate ? null : agent.id,
  );
  if (firstmateHome === null) return null;
  const { environmentId } = firstmateHome;
  const snapshot = firstmate ? firstmateHome.snapshot : agentQuery.data;
  const coordinatorThreadId = firstmate
    ? firstmateHome.snapshot.coordinatorThreadId
    : agent.coordinatorThreadId;
  if (coordinatorThreadId === null) return null;
  return (
    <>
      <SidebarGroup aria-label={`${agent.name}'s tasks`} className="mb-3">
        {snapshot === null ? (
          <p className="px-2 py-1 text-sm text-sidebar-muted-foreground/70">Loading tasks…</p>
        ) : (
          <AgentTaskTree
            environmentId={environmentId}
            coordinatorThreadId={coordinatorThreadId}
            tasks={snapshot.tasks}
            activeRouteKey={routeKey}
          />
        )}
      </SidebarGroup>
      <AgentAutomationsSection
        environmentId={environmentId}
        threadId={coordinatorThreadId}
        alwaysShow={!firstmate}
      />
    </>
  );
}
