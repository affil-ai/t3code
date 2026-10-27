/**
 * Fork: a fine-grained personal access token never gets the Checks permission, so GitHub refuses
 * `statusCheckRollup.contexts` with FORBIDDEN and a pull request's detail read failed outright,
 * dropping every watch on it. The detail read keeps the rest of GitHub's answer and takes its
 * checks from the head commit's legacy statuses and the rollup state, which such a token can
 * read. Any other GraphQL error still fails the read.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GraphQL, GraphQLClientError, GraphQLGroup } from "effect/graphql";

import * as Shared from "../../schema/github.graphql.ts";
import type { GitHubCheckContext } from "./gitHubPullRequestJson.ts";
import { PullRequestCore, StatusContext } from "./pullRequestReads.graphql.ts";

/** `repository.pullRequest.commits.nodes.<n>.commit.statusCheckRollup.contexts…` */
const isRefusedContextsPath = (path: unknown): path is ReadonlyArray<unknown> =>
  Array.isArray(path) &&
  path.length >= 8 &&
  path[0] === "repository" &&
  path[1] === "pullRequest" &&
  path[2] === "commits" &&
  path[3] === "nodes" &&
  typeof path[4] === "number" &&
  Number.isInteger(path[4]) &&
  path[4] >= 0 &&
  path[5] === "commit" &&
  path[6] === "statusCheckRollup" &&
  path[7] === "contexts";

/** Whether every one of GitHub's `errors` refuses the head commit's check contexts, beside data. */
export const isForbiddenCheckContextsOnly = (
  error: unknown,
): error is GraphQLClientError.GraphQLClientError =>
  GraphQLClientError.isGraphQLClientError(error) &&
  error.reason._tag === "ResponseError" &&
  error.reason.status === 200 &&
  typeof error.reason.data === "object" &&
  error.reason.data !== null &&
  error.reason.errors.length > 0 &&
  error.reason.errors.every(
    ({ path, type }) => type === "FORBIDDEN" && isRefusedContextsPath(path),
  );

/**
 * The detail answer GitHub sent beside the refusal, with each refused rollup dropped so it decodes
 * whether GitHub nulled the nodes or the connection. An answer that still does not decode fails
 * with the original error.
 */
export const pullRequestCoreWithoutCheckContexts = (
  error: GraphQLClientError.GraphQLClientError,
): Effect.Effect<PullRequestCore.Result, GraphQLClientError.GraphQLClientError> => {
  const reason = error.reason;
  if (reason._tag !== "ResponseError") return Effect.fail(error);
  const data: unknown = structuredClone(reason.data);
  for (const { path } of reason.errors) {
    if (!isRefusedContextsPath(path)) continue;
    let commit: unknown = data;
    for (const key of path.slice(0, 6)) {
      commit =
        typeof commit === "object" && commit !== null
          ? (commit as Record<string | number, unknown>)[key as string | number]
          : undefined;
    }
    if (typeof commit === "object" && commit !== null) {
      (commit as Record<string, unknown>)["statusCheckRollup"] = null;
    }
  }
  return Schema.decodeUnknownEffect(PullRequestCore.result)(data).pipe(
    Effect.mapError(() => error),
  );
};

const CheckFallbackCommit = Schema.Struct({
  status: Schema.NullOr(Schema.Struct({ contexts: Schema.Array(StatusContext) })),
  statusCheckRollup: Schema.NullOr(
    Schema.Struct({ state: GraphQL.enumLiterals(Shared.StatusState.literals) }),
  ),
});

/** The head commit's legacy statuses and rollup state, neither of which needs Checks access. */
export const PullRequestCheckFallback = GraphQL.query("PullRequestCheckFallback", {
  document: {
    variables: [
      { name: "owner", body: "String!" },
      { name: "name", body: "String!" },
      { name: "number", body: "Int!" },
    ],
    selections: [
      {
        name: "repository",
        body: [
          "(owner:$",
          "owner",
          " name:$",
          "name",
          "){pullRequest(number:$",
          "number",
          "){headRefOid commits(last:1){nodes{commit{status{contexts{__typename context state targetUrl createdAt description}}statusCheckRollup{state}}}}}}",
        ],
      },
    ],
    fragments: [],
  },
  variables: {
    owner: Schema.String,
    name: Schema.String,
    number: Shared.Int,
  },
  result: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            headRefOid: Shared.GitObjectID,
            commits: Schema.Struct({
              nodes: Schema.NullOr(
                Schema.Array(Schema.NullOr(Schema.Struct({ commit: CheckFallbackCommit }))),
              ),
            }),
          }),
        ),
      }),
    ),
  }),
});
export declare namespace PullRequestCheckFallback {
  export type Result = typeof PullRequestCheckFallback.result.Type;
}

export const PullRequestCheckFallbackGraphQLGroup = GraphQLGroup.make(PullRequestCheckFallback);

/**
 * The fallback's statuses plus the rollup state as one nameless context, which counts toward the
 * checks state without showing as a check; null for a pull request GitHub did not find.
 */
export function toCheckFallbackContexts(result: PullRequestCheckFallback.Result): {
  readonly headSha: string;
  readonly contexts: ReadonlyArray<GitHubCheckContext>;
} | null {
  const pr = result.repository?.pullRequest;
  if (pr == null) return null;
  const commit = pr.commits.nodes?.[0]?.commit;
  return {
    headSha: pr.headRefOid,
    contexts: [
      ...(commit?.status?.contexts ?? []),
      ...(commit?.statusCheckRollup == null ? [] : [{ state: commit.statusCheckRollup.state }]),
    ],
  };
}
