import {
  AgentCreateResult,
  AgentCreateToolInput,
  AgentListToolInput,
  AgentListToolResult,
  AgentProfile,
  AgentTasksToolInput,
  AgentUpdateInput,
  FirstmateError,
  FirstmateTaskCreateInput,
  FirstmateTaskGetInput,
  FirstmateTaskGetResult,
  FirstmateTaskListInput,
  FirstmateTaskListResult,
  FirstmateTaskMutationResult,
  FirstmateTaskUpdateInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as FirstmateService from "../../../firstmate/FirstmateService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  FirstmateService.FirstmateService,
  ThreadManagementService.ThreadManagementService,
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
    "List the tasks on your board. Omit state to list every task that is not done or dropped.",
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
    "Create a task on your board. Only an agent's coordinator chat may create its tasks.",
  parameters: FirstmateTaskCreateInput,
  success: FirstmateTaskMutationResult,
})
  .annotate(Tool.Title, "Create task")
  .annotate(Tool.Destructive, true);

const FirstmateTaskUpdateTool = Tool.make("firstmate_task_update", {
  ...shared,
  description:
    "Partially update a task on your board and append an event. Only an agent's coordinator chat may update its tasks. Closing requires closeEvidence. Set state waiting while a PR waits on reviews or checks, and ready once it is reviewed and green and only the user's merge or deploy remains; put the PR in links or artifacts.",
  parameters: FirstmateTaskUpdateInput,
  success: FirstmateTaskMutationResult,
})
  .annotate(Tool.Title, "Update task")
  .annotate(Tool.Destructive, true);

const AgentListTool = Tool.make("agent_list", {
  ...shared,
  description:
    "List the user's agents: each one's id, name, role, and coordinator chat. Only an agent's coordinator chat may call it.",
  parameters: AgentListToolInput,
  success: AgentListToolResult,
})
  .annotate(Tool.Title, "List agents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AgentTasksTool = Tool.make("agent_tasks", {
  ...shared,
  description:
    "Read another agent's task board, read-only. Omit state to list every task that is not done or dropped. Only an agent's coordinator chat may call it.",
  parameters: AgentTasksToolInput,
  success: FirstmateTaskListResult,
})
  .annotate(Tool.Title, "Read an agent's tasks")
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

export const FirstmateToolkit = Toolkit.make(
  FirstmateTaskListTool,
  FirstmateTaskGetTool,
  FirstmateTaskCreateTool,
  FirstmateTaskUpdateTool,
  AgentListTool,
  AgentTasksTool,
  AgentCreateTool,
  AgentUpdateTool,
);
