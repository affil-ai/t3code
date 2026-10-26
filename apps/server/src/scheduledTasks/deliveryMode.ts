import type {
  OrchestrationV2ExecutionNode,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

/** Records `steerSendMode` reads; load them with `omitSettledLeafNodes`. */
export const SEND_MODE_RECORDS = [
  "runs",
  "nodes",
  "providerThreads",
  "providerSessions",
  "providerTurns",
] as const;

type SendModeProjection = Pick<OrchestrationV2ThreadProjection, (typeof SEND_MODE_RECORDS)[number]>;

/** Work a steer would cut short on a provider whose steering cancels pending tools. */
const TOOL_NODE_KINDS: ReadonlySet<OrchestrationV2ExecutionNode["kind"]> = new Set([
  "tool_call",
  "approval_request",
  "user_input_request",
  "subagent",
  "hook",
]);
const OPEN_NODE_STATUSES: ReadonlySet<OrchestrationV2ExecutionNode["status"]> = new Set([
  "pending",
  "running",
  "waiting",
]);

/**
 * The `sendToThread` mode for a steer-mode run of a task bound to a thread.
 *
 * It uses `auto`: it starts an idle thread, steers a running provider turn,
 * and queues behind a turn that cannot take input yet. Claude's native steering
 * cancels pending tools, so while such a turn has a tool, approval, question or
 * subagent open the run queues instead and never cuts that work short.
 */
export function steerSendMode(projection: SendModeProjection): "auto" | "queue" {
  const run = projection.runs
    .filter(
      (candidate) =>
        candidate.status === "running" &&
        candidate.activeAttemptId !== null &&
        projection.providerTurns.some(
          (turn) => turn.runAttemptId === candidate.activeAttemptId && turn.status === "running",
        ),
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  // Nothing to steer: auto starts an idle thread or queues behind a busy one.
  if (run === undefined) return "auto";
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  const turns = projection.providerSessions.find(
    (session) => session.id === providerThread?.providerSessionId,
  )?.capabilities.turns;
  if (turns?.supportsActiveSteering !== true) return "queue";
  if (turns.activeSteeringInterruptsTools !== true) return "auto";
  const toolOpen = projection.nodes.some(
    (node) =>
      node.runId === run.id &&
      TOOL_NODE_KINDS.has(node.kind) &&
      OPEN_NODE_STATUSES.has(node.status),
  );
  return toolOpen ? "queue" : "auto";
}
