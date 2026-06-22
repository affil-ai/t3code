/**
 * Fetches pull requests across the dashboard's selected projects, grouped by environment.
 *
 * PRs are not streamed — they are fetched live server-side. This hook calls the
 * `git.listPullRequests` RPC (added for the dashboard) with each environment's project
 * cwds, on mount and on demand via `refresh`. Results are held in local component state.
 */

import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DashboardPullRequest } from "../dashboardIssues";
import { ensureEnvironmentApi } from "../environmentApi";

const DASHBOARD_PULL_REQUEST_LIMIT = 500;

export interface DashboardPullRequestTarget {
  environmentId: EnvironmentId;
  cwds: ReadonlyArray<string>;
}

export interface DashboardPullRequestsState {
  pullRequests: ReadonlyArray<DashboardPullRequest>;
  /** Per-cwd fetch failures (e.g. unauthenticated provider) — surfaced, not fatal. */
  failures: ReadonlyArray<{ environmentId: EnvironmentId; cwd: string; message: string }>;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useDashboardPullRequests(input: {
  targets: ReadonlyArray<DashboardPullRequestTarget>;
  state?: "open" | "closed" | "merged" | "all";
}): DashboardPullRequestsState {
  const { targets } = input;
  const prState = input.state ?? "all";
  const [pullRequests, setPullRequests] = useState<ReadonlyArray<DashboardPullRequest>>([]);
  const [failures, setFailures] = useState<
    ReadonlyArray<{ environmentId: EnvironmentId; cwd: string; message: string }>
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A monotonically increasing token guards against out-of-order/stale responses.
  const requestTokenRef = useRef(0);
  // Stable key so the auto-fetch effect re-runs only when the inputs actually change.
  const targetsKey = JSON.stringify(
    targets
      .map((target) => ({
        environmentId: target.environmentId,
        cwds: [...target.cwds].sort(),
      }))
      .sort((left, right) => left.environmentId.localeCompare(right.environmentId)),
  );

  const fetchPullRequests = useCallback(() => {
    const activeTargets = targets.filter((target) => target.cwds.length > 0);
    if (activeTargets.length === 0) {
      setPullRequests([]);
      setFailures([]);
      setError(null);
      setIsLoading(false);
      return;
    }
    const token = ++requestTokenRef.current;
    setIsLoading(true);
    setError(null);
    void Promise.all(
      activeTargets.map(async (target) => {
        try {
          const result = await ensureEnvironmentApi(target.environmentId).git.listPullRequests({
            cwds: [...target.cwds],
            state: prState,
            limit: DASHBOARD_PULL_REQUEST_LIMIT,
          });
          return {
            pullRequests: result.pullRequests.map((pullRequest) => ({
              ...pullRequest,
              environmentId: target.environmentId,
            })),
            failures: result.failures.map((failure) => ({
              ...failure,
              environmentId: target.environmentId,
            })),
          };
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          return {
            pullRequests: [],
            failures: target.cwds.map((cwd) => ({
              environmentId: target.environmentId,
              cwd,
              message,
            })),
          };
        }
      }),
    )
      .then((results) => {
        if (token !== requestTokenRef.current) {
          return;
        }
        setPullRequests(results.flatMap((result) => result.pullRequests));
        setFailures(results.flatMap((result) => result.failures));
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (token !== requestTokenRef.current) {
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- targetsKey stands in for targets
  }, [targetsKey, prState]);

  useEffect(() => {
    fetchPullRequests();
  }, [fetchPullRequests]);

  return { pullRequests, failures, isLoading, error, refresh: fetchPullRequests };
}
