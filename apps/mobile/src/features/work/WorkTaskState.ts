/**
 * State for the Work task detail: finding the task on whichever agent's board
 * holds it, the live state of a pull request linked from it, and sending a
 * request to the agent's coordinator chat.
 */
import { useAtomValue } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { createLinkedPullRequestSummaryAtomFamily } from "@t3tools/client-runtime/state/pull-requests";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type FirstmateSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { uuidv4 } from "../../lib/uuid";
import { agentsEnvironment } from "../../state/agents";
import { useProjects } from "../../state/entities";
import { firstmateEnvironment } from "../../state/firstmate";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import {
  orderAgentsForLookup,
  resolveWorkTaskLookup,
  type WorkTaskBoard,
  type WorkTaskLookup,
} from "./WorkTaskModel";

function boardFrom(
  agent: WorkTaskBoard["agent"],
  result: AsyncResult.AsyncResult<FirstmateSnapshot, unknown>,
): WorkTaskBoard {
  return {
    agent,
    snapshot: AsyncResult.isSuccess(result) ? result.value : null,
    loading: AsyncResult.isInitial(result),
  };
}

const workTaskLookupAtom = Atom.family((key: string) => {
  const [environmentId, taskId, agentIdHint] = JSON.parse(key) as [
    EnvironmentId,
    string,
    string | null,
  ];
  return Atom.make((get): WorkTaskLookup => {
    const agentsResult = get(agentsEnvironment.live({ environmentId, input: {} }));
    if (AsyncResult.isInitial(agentsResult)) return { kind: "loading" };
    if (AsyncResult.isFailure(agentsResult)) {
      // A server without agents has only Firstmate's board.
      const firstmate = get(firstmateEnvironment.live({ environmentId, input: {} }));
      return resolveWorkTaskLookup(taskId, [boardFrom(null, firstmate)]);
    }
    const agents = orderAgentsForLookup(agentsResult.value.agents, agentIdHint ?? undefined);
    // Lazy, so boards after the one holding the task are never opened.
    function* boards(): Generator<WorkTaskBoard> {
      for (const agent of agents) {
        yield boardFrom(
          agent,
          get(agentsEnvironment.tasks({ environmentId, input: { agentId: agent.id } })),
        );
      }
    }
    return resolveWorkTaskLookup(taskId, boards());
  }).pipe(Atom.withLabel("work:task-lookup"));
});

/** The task with its agent and coordinator chat, live from its board. */
export function useWorkTaskLookup(
  environmentId: EnvironmentId,
  taskId: string,
  agentIdHint: string | undefined,
): WorkTaskLookup {
  return useAtomValue(
    workTaskLookupAtom(JSON.stringify([environmentId, taskId, agentIdHint ?? null])),
  );
}

const linkedPullRequestSummaryAtom = createLinkedPullRequestSummaryAtomFamily(
  connectionAtomRuntime,
  composerPullRequests.refreshes,
);

/**
 * A pull request link's project and live summary, when a project on this
 * environment holds the repository. Null fields mean the link opens in the
 * browser and draws without a state.
 */
export function useWorkTaskPullRequest(environmentId: EnvironmentId, url: string) {
  const projects = useProjects();
  const pullRequestsEnabled = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities.pullRequests === true,
  );
  const parsed = pullRequestsEnabled
    ? (sourceControlClients.parseChangeRequestUrl(url)?.link ?? null)
    : null;
  const project =
    parsed === null
      ? undefined
      : projects.find(
          (candidate) =>
            candidate.environmentId === environmentId &&
            candidate.repositoryIdentity?.provider !== undefined &&
            sourceControlClients
              .get(candidate.repositoryIdentity.provider)
              .isChangeRequestInRepository(candidate.repositoryIdentity, parsed),
        );
  const summary = useEnvironmentQuery(
    parsed === null || project === undefined
      ? null
      : linkedPullRequestSummaryAtom({
          environmentId,
          input: {
            projectId: project.id,
            host: parsed.authority ?? parsed.host,
            repository:
              sourceControlClients.repositorySelector(project.repositoryIdentity) ?? parsed.repository,
            number: parsed.number,
          },
        }),
  ).data;
  return {
    projectId: project?.id ?? null,
    summary,
  };
}

/**
 * Queues a message to a chat through the thread outbox, the composer's own
 * delivery path: it waits behind a running turn and survives a dropped
 * connection.
 */
export function sendWorkTaskMessage(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
}): Promise<void> {
  return enqueueThreadOutboxMessage({
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: MessageId.make(uuidv4()),
    commandId: CommandId.make(uuidv4()),
    text: input.text,
    attachments: [],
    dispatchMode: "queue",
    createdAt: new Date().toISOString(),
  });
}
