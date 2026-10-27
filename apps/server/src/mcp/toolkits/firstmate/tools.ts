import {
  AgentCreateResult,
  AgentCreateToolInput,
  AgentListToolInput,
  AgentListToolResult,
  AgentProfile,
  AgentAutomationDeleteToolInput,
  AgentAutomationDeleteToolResult,
  AgentAutomationGetToolInput,
  AgentAutomationMutationResult,
  AgentAutomationsToolInput,
  AgentAutomationsToolResult,
  AgentAutomationUpdateToolInput,
  AgentTaskGetToolInput,
  AgentTasksToolResult,
  AgentTasksToolInput,
  AgentUpdateInput,
  FirstmateError,
  FirstmateTaskCreateInput,
  FirstmateTaskGetInput,
  FirstmateTaskGetResult,
  FirstmateTaskListInput,
  FirstmateTaskListResult,
  FirstmateTaskMutationResult,
  FirstmateTaskReportProgressInput,
  FirstmateTaskUpdateInput,
  OrchestratorMcpFailure,
  StandupListInput,
  StandupListResult,
  StandupMarkInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as FirstmateService from "../../../firstmate/FirstmateService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as AgentMcpService from "../../AgentMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  FirstmateService.FirstmateService,
  ThreadManagementService.ThreadManagementService,
  AgentMcpService.AgentMcpService,
];

export const FirstmateToolError = Schema.Union([FirstmateError, OrchestratorMcpFailure]);
export type FirstmateToolError = typeof FirstmateToolError.Type;

const shared = {
  failure: FirstmateToolError,
  failureMode: "return" as const,
  dependencies,
};

const FirstmateTaskListTool = Tool.make("firstmate_task_list", {
  ...shared,
  description:
    "List the tasks on your board. Filter by status (including backlog, monitoring, or hillclimb) or legacy state. Omit both to list every task that is not done or dropped, which includes monitoring tasks. Backlog is intentionally parked: do not start workers or schedule wakes for it.",
  parameters: FirstmateTaskListInput,
  success: FirstmateTaskListResult,
})
  .annotate(Tool.Title, "List tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FirstmateTaskGetTool = Tool.make("firstmate_task_get", {
  ...shared,
  description: "Read one task on your board and its append-only event log.",
  parameters: FirstmateTaskGetInput,
  success: FirstmateTaskGetResult,
})
  .annotate(Tool.Title, "Get task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FirstmateTaskCreateTool = Tool.make("firstmate_task_create", {
  ...shared,
  description:
    "Create a task on your board. Only an agent's coordinator chat may create its tasks. Set status explicitly: backlog for deferred work, planning, in_progress, in_review, ready_for_deployment, monitoring (live in production with post-release checks open, such as error watch, readbacks, or backfills), or hillclimb (a worker climbing a measured goal; keep the title plain, the worker reports its score with task_report_progress). Backlog is parked: do not launch a worker until the user asks to start it. Give it a nextStep: a short imperative phrase naming the PR or decision.",
  parameters: FirstmateTaskCreateInput,
  success: FirstmateTaskMutationResult,
})
  .annotate(Tool.Title, "Create task")
  .annotate(Tool.Destructive, true);

const FirstmateTaskUpdateTool = Tool.make("firstmate_task_update", {
  ...shared,
  description:
    'Partially update a task on your board and append an event. Only an agent\'s coordinator chat may update its tasks. Set status explicitly for lifecycle moves: backlog, planning, in_progress, in_review, ready_for_deployment, monitoring, hillclimb, done, or canceled. Move a merged, live task to monitoring, not done, while post-release checks (error watch, readbacks, production checks, backfills) are open; it stays active and can wake you. Use nextActor separately for who acts next. Whenever you change status, state, or nextActor, also set nextStep: a short imperative phrase naming the PR or decision ("Approve merge of #4118", "Waiting on Office review"), not a sentence about who acts. Closing requires closeEvidence. Backlog tasks are parked and do not wake the coordinator. progress sets the progress line shown under the title; workers usually report it themselves.',
  parameters: FirstmateTaskUpdateInput,
  success: FirstmateTaskMutationResult,
})
  .annotate(Tool.Title, "Update task")
  .annotate(Tool.Destructive, true);

const FirstmateTaskReportProgressTool = Tool.make("task_report_progress", {
  ...shared,
  description:
    'Report your measured progress on the board task you work on, shown under its title: a metric ("Recall 87.5%, baseline 72%, target 90%") or a count ("1,611 / 1,942 hotels", with the total as target). Only the task\'s worker chat, or a subagent it delegated to, may call it, and it changes nothing but progress. Report again whenever the number moves; the board keeps a short history for a sparkline. Keep the score out of the title.',
  parameters: FirstmateTaskReportProgressInput,
  success: FirstmateTaskMutationResult,
})
  .annotate(Tool.Title, "Report task progress")
  .annotate(Tool.Destructive, false);

const AgentListTool = Tool.make("agent_list", {
  ...shared,
  description:
    "Discover this environment's unarchived crew, including each agent's id, name, role, home project, model, and coordinator chat. Available to approved external MCP clients, including read-only clients, and agent coordinator chats. Filter by name and paginate with cursor/limit. No coordinator is impersonated.",
  parameters: AgentListToolInput,
  success: AgentListToolResult,
})
  .annotate(Tool.Title, "List agents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AgentTasksTool = Tool.make("agent_tasks", {
  ...shared,
  description:
    "Read an explicitly targeted agent's task board, read-only. External MCP clients must pass agentId; coordinator chats may read another agent's board. Omit state to list every task that is not done or dropped. Results include lifecycle state, priority, next actor, next action, and a cursor for pagination.",
  parameters: AgentTasksToolInput,
  success: AgentTasksToolResult,
})
  .annotate(Tool.Title, "Read an agent's tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AgentTaskGetTool = Tool.make("agent_task_get", {
  ...shared,
  description:
    "Read one explicitly targeted agent task and its append-only event log. External MCP clients must pass both agentId and taskId; a task from another agent is not visible.",
  parameters: AgentTaskGetToolInput,
  success: FirstmateTaskGetResult,
})
  .annotate(Tool.Title, "Read an agent task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AgentAutomationsTool = Tool.make("agent_automations", {
  ...shared,
  description:
    "List recurring automations explicitly targeted to an agent. External MCP clients must pass agentId. Only schedules bound to that agent's coordinator chat are returned, with enabled state, trigger, next run, recent run status/error/count, and cursor pagination. Webhook URLs and secrets are never returned.",
  parameters: AgentAutomationsToolInput,
  success: AgentAutomationsToolResult,
})
  .annotate(Tool.Title, "List agent automations")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AgentAutomationUpdateTool = Tool.make("agent_automation_update", {
  ...shared,
  description:
    "Update an automation explicitly targeted to an agent. Requires write approval covering both the automation's saved modes and its coordinator's current modes. Read-only clients are denied. The automation must be bound to that agent's coordinator chat; this tool cannot rebind it. Omit fields to preserve them; enabled=false pauses future triggers without canceling work already dispatched.",
  parameters: AgentAutomationUpdateToolInput,
  success: AgentAutomationMutationResult,
})
  .annotate(Tool.Title, "Update an agent automation")
  .annotate(Tool.Destructive, true);

const AgentAutomationDeleteTool = Tool.make("agent_automation_delete", {
  ...shared,
  description:
    "Permanently delete an automation explicitly targeted to an agent. Requires write approval covering the automation's and coordinator's modes. Read-only clients are denied. The automation must be bound to that agent's coordinator chat. Does not cancel work already dispatched.",
  parameters: AgentAutomationDeleteToolInput,
  success: AgentAutomationDeleteToolResult,
})
  .annotate(Tool.Title, "Delete an agent automation")
  .annotate(Tool.Destructive, true);

const AgentAutomationGetTool = Tool.make("agent_automation_get", {
  ...shared,
  description:
    "Read one automation by agentId and scheduledTaskId, including its prompt, trigger, enabled state, next run, and last scheduler dispatch result. Only schedules bound to that agent's coordinator chat qualify. Webhook URLs and secrets are never returned. A successful dispatch does not mean the agent's turn completed.",
  parameters: AgentAutomationGetToolInput,
  success: AgentAutomationMutationResult,
})
  .annotate(Tool.Title, "Read an agent automation")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AgentCreateTool = Tool.make("agent_create", {
  ...shared,
  description:
    "Create an agent: records it, seeds its folder under crew/ in the agents repository, and starts its coordinator chat. Returns the agent and its chat's thread id. Only an agent's coordinator chat may call it.",
  parameters: AgentCreateToolInput,
  success: AgentCreateResult,
})
  .annotate(Tool.Title, "Create agent")
  .annotate(Tool.Destructive, false);

const AgentUpdateTool = Tool.make("agent_update", {
  ...shared,
  description:
    "Change an agent's name, icon, color, or role. Omitted fields are unchanged; a new role rewrites the top of its AGENTS.md. Only an agent's coordinator chat may call it.",
  parameters: AgentUpdateInput,
  success: AgentProfile,
})
  .annotate(Tool.Title, "Update agent")
  .annotate(Tool.Destructive, true);

const StandupMarkTool = Tool.make("standup_mark", {
  ...shared,
  description:
    "Put a task on the user's standup, or take it off. The task may be on any agent's board (pass agentId); this changes only its standup mark and dates, never the owner's other fields. A standup task shows in the Standup section until it is done, monitoring, or canceled. For a to-do with no task yet, create one on your board first (backlog if no one is working on it). Only Firstmate's coordinator chat may call it.",
  parameters: StandupMarkInput,
  success: FirstmateTaskMutationResult,
})
  .annotate(Tool.Title, "Mark standup task")
  .annotate(Tool.Destructive, false);

const StandupListTool = Tool.make("standup_list", {
  ...shared,
  description:
    "List the user's open standup tasks across every agent's board, oldest first, each with its owner. includeFinished adds recently finished ones with their standup start and finish dates, for drafting what the user did.",
  parameters: StandupListInput,
  success: StandupListResult,
})
  .annotate(Tool.Title, "List standup tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const FirstmateToolkit = Toolkit.make(
  FirstmateTaskListTool,
  FirstmateTaskGetTool,
  FirstmateTaskCreateTool,
  FirstmateTaskUpdateTool,
  FirstmateTaskReportProgressTool,
  AgentListTool,
  AgentTasksTool,
  AgentTaskGetTool,
  AgentAutomationsTool,
  AgentAutomationGetTool,
  AgentAutomationUpdateTool,
  AgentAutomationDeleteTool,
  AgentCreateTool,
  AgentUpdateTool,
  StandupMarkTool,
  StandupListTool,
);
