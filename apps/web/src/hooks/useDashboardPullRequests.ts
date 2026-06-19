/**
 * Fetches pull requests across the projects of a single environment for the dashboard.
 *
 * PRs are not streamed — they are fetched live server-side. This hook calls the
 * `git.listPullRequests` RPC (added for the dashboard) with the environment's project
 * cwds, on mount and on demand via `refresh`. Results are held in local component state.
 */

import type { EnvironmentId, GitListedPullRequest } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../environmentApi";

export interface DashboardPullRequestsState {
  pullRequests: ReadonlyArray<GitListedPullRequest>;
  /** Per-cwd fetch failures (e.g. unauthenticated provider) — surfaced, not fatal. */
  failures: ReadonlyArray<{ cwd: string; message: string }>;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useDashboardPullRequests(input: {
  environmentId: EnvironmentId | null;
  cwds: ReadonlyArray<string>;
  state?: "open" | "closed" | "merged" | "all";
}): DashboardPullRequestsState {
  const { environmentId, cwds } = input;
  const prState = input.state ?? "all";
  const [pullRequests, setPullRequests] = useState<ReadonlyArray<GitListedPullRequest>>([]);
  const [failures, setFailures] = useState<ReadonlyArray<{ cwd: string; message: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A monotonically increasing token guards against out-of-order/stale responses.
  const requestTokenRef = useRef(0);
  // Stable key so the auto-fetch effect re-runs only when the inputs actually change.
  const cwdsKey = JSON.stringify([...cwds].sort());

  const fetchPullRequests = useCallback(() => {
    if (!environmentId || cwds.length === 0) {
      setPullRequests([]);
      setFailures([]);
      setError(null);
      setIsLoading(false);
      return;
    }
    const token = ++requestTokenRef.current;
    setIsLoading(true);
    setError(null);
    void ensureEnvironmentApi(environmentId)
      .git.listPullRequests({ cwds: [...cwds], state: prState })
      .then((result) => {
        if (token !== requestTokenRef.current) {
          return;
        }
        setPullRequests(result.pullRequests);
        setFailures(result.failures);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (token !== requestTokenRef.current) {
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cwdsKey stands in for cwds
  }, [environmentId, cwdsKey, prState]);

  useEffect(() => {
    fetchPullRequests();
  }, [fetchPullRequests]);

  return { pullRequests, failures, isLoading, error, refresh: fetchPullRequests };
}
