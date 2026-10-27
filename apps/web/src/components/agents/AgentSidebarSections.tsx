/**
 * The selected agent's part of the Work sidebar, under its row: open tasks
 * (a task with a worker opens the worker's chat) and automations. Firstmate's
 * board comes from its own stream, any other agent's from `agents.tasks`.
 * The Standup section leads: every agent's standup tasks under Firstmate, an
 * agent's own under it. The agent's own sections are absent until it has a chat.
 */
import { type AgentProfile, FIRSTMATE_AGENT_ID } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";

import { useAgentsHome, useAgentTasks, useStandupTasks } from "~/state/agents";
import { useFirstmateHome } from "~/state/firstmate";
import { resolveThreadRouteRef } from "~/threadRoutes";
import { SidebarGroup } from "../ui/sidebar";
import { AgentAutomationsSection } from "./AgentAutomationsSection";
import { AgentTaskTree } from "./AgentTaskTree";
import { StandupSection } from "./StandupSection";

export function AgentSidebarSections({ agent }: { readonly agent: AgentProfile }) {
  const routeKey = useParams({
    strict: false,
    select: (params) => {
      const ref = resolveThreadRouteRef(params);
      return ref ? `${ref.environmentId}:${ref.threadId}` : null;
    },
  });
  const firstmate = agent.id === FIRSTMATE_AGENT_ID;
  const agentsHome = useAgentsHome();
  const firstmateHome = useFirstmateHome();
  const allStandupRows = useStandupTasks();
  const agentQuery = useAgentTasks(
    firstmate ? null : (agentsHome?.environmentId ?? null),
    firstmate ? null : agent.id,
  );
  const environmentId = firstmate ? firstmateHome?.environmentId : agentsHome?.environmentId;
  if (environmentId === undefined) return null;
  const standupRows = firstmate
    ? allStandupRows
    : allStandupRows.filter((row) => row.agent.id === agent.id);
  const standup =
    agentsHome === null ? null : (
      <StandupSection
        environmentId={agentsHome.environmentId}
        rows={standupRows}
        agents={agentsHome.agents}
        activeRouteKey={routeKey}
      />
    );
  const snapshot = firstmate ? (firstmateHome?.snapshot ?? null) : agentQuery.data;
  const coordinatorThreadId = firstmate
    ? (firstmateHome?.snapshot.coordinatorThreadId ?? null)
    : agent.coordinatorThreadId;
  if (coordinatorThreadId === null) return standup;
  return (
    <>
      <SidebarGroup aria-label={`${agent.name}'s tasks`} className="mb-3">
        {standup}
        {snapshot === null ? (
          <p className="px-2 py-1 text-sm text-sidebar-muted-foreground/70">Loading tasks…</p>
        ) : (
          <AgentTaskTree
            key={`${environmentId}:${coordinatorThreadId}`}
            environmentId={environmentId}
            coordinatorThreadId={coordinatorThreadId}
            tasks={snapshot.tasks}
            activeRouteKey={routeKey}
            hasStandup={standupRows.length > 0}
          />
        )}
      </SidebarGroup>
      <AgentAutomationsSection environmentId={environmentId} threadId={coordinatorThreadId} />
    </>
  );
}
