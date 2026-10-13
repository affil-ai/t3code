import {
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
  description: "List Firstmate tasks. Omit state to list every task that is not done or dropped.",
  parameters: FirstmateTaskListInput,
  success: FirstmateTaskListResult,
})
  .annotate(Tool.Title, "List Firstmate tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FirstmateTaskGetTool = Tool.make("firstmate_task_get", {
  ...shared,
  description: "Read one Firstmate task and its append-only event log.",
  parameters: FirstmateTaskGetInput,
  success: FirstmateTaskGetResult,
})
  .annotate(Tool.Title, "Get Firstmate task")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FirstmateTaskCreateTool = Tool.make("firstmate_task_create", {
  ...shared,
  description:
    "Create a Firstmate task. Only the configured Firstmate coordinator may create tasks.",
  parameters: FirstmateTaskCreateInput,
  success: FirstmateTaskMutationResult,
})
  .annotate(Tool.Title, "Create Firstmate task")
  .annotate(Tool.Destructive, true);

const FirstmateTaskUpdateTool = Tool.make("firstmate_task_update", {
  ...shared,
  description:
    "Partially update a Firstmate task and append an event. Only the configured Firstmate coordinator may update tasks. Closing requires closeEvidence.",
  parameters: FirstmateTaskUpdateInput,
  success: FirstmateTaskMutationResult,
})
  .annotate(Tool.Title, "Update Firstmate task")
  .annotate(Tool.Destructive, true);

export const FirstmateToolkit = Toolkit.make(
  FirstmateTaskListTool,
  FirstmateTaskGetTool,
  FirstmateTaskCreateTool,
  FirstmateTaskUpdateTool,
);
