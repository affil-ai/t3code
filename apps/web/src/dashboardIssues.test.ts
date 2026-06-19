import { describe, expect, it } from "vite-plus/test";
import type { GitListedPullRequest } from "@t3tools/contracts";

import {
  buildDashboardIssues,
  deriveIssueStatus,
  filterIssues,
  inferWorktreeOrigin,
  normalizeBranchKey,
  sortIssues,
  type DashboardFilters,
} from "./dashboardIssues";
import type { Project, SidebarThreadSummary } from "./types";

const ENV = "env-1";

function project(id: string, cwd: string): Project {
  return {
    id: id as Project["id"],
    environmentId: ENV as Project["environmentId"],
    name: id,
    cwd,
    defaultModelSelection: null,
    scripts: [],
  };
}

function thread(input: {
  id: string;
  projectId: string;
  branch: string | null;
  worktreePath?: string | null;
  createdAt?: string;
  updatedAt?: string;
  slackUrl?: string;
  externalLink?: { url: string; source: string | null };
}): SidebarThreadSummary {
  return {
    id: input.id as SidebarThreadSummary["id"],
    environmentId: ENV as SidebarThreadSummary["environmentId"],
    projectId: input.projectId as SidebarThreadSummary["projectId"],
    title: `Thread ${input.id}`,
    interactionMode: "agent" as SidebarThreadSummary["interactionMode"],
    session: null,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
    latestTurn: null,
    branch: input.branch,
    worktreePath: input.worktreePath ?? null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...(input.slackUrl
      ? { externalThreadLink: { muted: false, url: input.slackUrl, source: "slack" } }
      : input.externalLink
        ? {
            externalThreadLink: {
              muted: false,
              url: input.externalLink.url,
              source: input.externalLink.source,
            },
          }
        : {}),
  };
}

function pr(input: {
  cwd: string;
  number: number;
  headRefName: string;
  state: GitListedPullRequest["state"];
  isDraft?: boolean;
  updatedAt?: string | null;
}): GitListedPullRequest {
  return {
    cwd: input.cwd,
    provider: "github",
    number: input.number,
    title: `PR #${input.number}`,
    url: `https://example.test/pr/${input.number}`,
    baseRefName: "main",
    headRefName: input.headRefName,
    state: input.state,
    updatedAt: input.updatedAt ?? null,
    ...(input.isDraft !== undefined ? { isDraft: input.isDraft } : {}),
  };
}

describe("normalizeBranchKey", () => {
  it("lowercases and strips an owner prefix", () => {
    expect(normalizeBranchKey("Owner:Feature/Foo")).toBe("feature/foo");
    expect(normalizeBranchKey("feature/foo")).toBe("feature/foo");
  });

  it("returns null for empty/missing branches", () => {
    expect(normalizeBranchKey(null)).toBeNull();
    expect(normalizeBranchKey("   ")).toBeNull();
  });
});

describe("deriveIssueStatus", () => {
  it("maps PR state and draft flag", () => {
    expect(
      deriveIssueStatus({
        pullRequest: pr({ cwd: "/a", number: 1, headRefName: "b", state: "merged" }),
        hasWorktree: false,
      }),
    ).toBe("merged");
    expect(
      deriveIssueStatus({
        pullRequest: pr({ cwd: "/a", number: 1, headRefName: "b", state: "closed" }),
        hasWorktree: false,
      }),
    ).toBe("closed");
    expect(
      deriveIssueStatus({
        pullRequest: pr({ cwd: "/a", number: 1, headRefName: "b", state: "open", isDraft: true }),
        hasWorktree: true,
      }),
    ).toBe("draft");
    expect(
      deriveIssueStatus({
        pullRequest: pr({ cwd: "/a", number: 1, headRefName: "b", state: "open" }),
        hasWorktree: true,
      }),
    ).toBe("ready");
  });

  it("falls back to worktree-only and null", () => {
    expect(deriveIssueStatus({ pullRequest: null, hasWorktree: true })).toBe("worktree-only");
    expect(deriveIssueStatus({ pullRequest: null, hasWorktree: false })).toBeNull();
  });
});

describe("inferWorktreeOrigin", () => {
  it("prefers slack, then PR, then manual", () => {
    expect(
      inferWorktreeOrigin({
        hasWorktree: true,
        externalSource: "slack",
        matchedPullRequest: false,
      }),
    ).toBe("slack");
    expect(
      inferWorktreeOrigin({ hasWorktree: true, externalSource: null, matchedPullRequest: true }),
    ).toBe("pull-request");
    expect(
      inferWorktreeOrigin({ hasWorktree: true, externalSource: null, matchedPullRequest: false }),
    ).toBe("manual");
    expect(
      inferWorktreeOrigin({
        hasWorktree: false,
        externalSource: "slack",
        matchedPullRequest: true,
      }),
    ).toBe("none");
  });
});

describe("buildDashboardIssues", () => {
  const projectA = project("proj-a", "/repo/a");

  it("joins a thread to a PR by branch within the same project", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [
        thread({ id: "t1", projectId: "proj-a", branch: "feature/x", worktreePath: "/wt/x" }),
      ],
      pullRequests: [pr({ cwd: "/repo/a", number: 7, headRefName: "feature/x", state: "open" })],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.status).toBe("ready");
    expect(issues[0]?.pullRequest?.number).toBe(7);
    expect(issues[0]?.thread?.id).toBe("t1");
    expect(issues[0]?.title).toBe("PR #7");
  });

  it("does not join across projects with the same branch name", () => {
    const projectB = project("proj-b", "/repo/b");
    const issues = buildDashboardIssues({
      projects: [projectA, projectB],
      threads: [thread({ id: "t1", projectId: "proj-a", branch: "shared", worktreePath: "/wt/x" })],
      // PR lives in project B, thread in project A → no join.
      pullRequests: [pr({ cwd: "/repo/b", number: 9, headRefName: "shared", state: "open" })],
    });
    const threadIssue = issues.find((issue) => issue.thread?.id === "t1");
    const prIssue = issues.find((issue) => issue.pullRequest?.number === 9);
    expect(threadIssue?.status).toBe("worktree-only");
    expect(threadIssue?.pullRequest).toBeNull();
    expect(prIssue?.thread).toBeNull();
    expect(prIssue?.status).toBe("ready");
  });

  it("surfaces an unmatched PR as a standalone create-able issue", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [],
      pullRequests: [pr({ cwd: "/repo/a", number: 3, headRefName: "lonely", state: "open" })],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.thread).toBeNull();
    expect(issues[0]?.project?.id).toBe("proj-a");
  });

  it("drops threads with neither a PR nor a worktree", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [thread({ id: "t1", projectId: "proj-a", branch: "x", worktreePath: null })],
      pullRequests: [],
    });
    expect(issues).toHaveLength(0);
  });

  it("marks slack-derived worktrees and exposes the slack link", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [
        thread({
          id: "t1",
          projectId: "proj-a",
          branch: "from-slack",
          worktreePath: "/wt/s",
          slackUrl: "https://slack.test/archives/C/p123",
        }),
      ],
      pullRequests: [],
    });
    expect(issues[0]?.worktreeOrigin).toBe("slack");
    expect(issues[0]?.hasSlack).toBe(true);
    expect(issues[0]?.externalLink).toBe("https://slack.test/archives/C/p123");
  });

  it("does not flag a non-Slack external link as hasSlack", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [
        thread({
          id: "t1",
          projectId: "proj-a",
          branch: "from-email",
          worktreePath: "/wt/e",
          externalLink: { url: "https://mail.test/thread/1", source: "support_email" },
        }),
      ],
      pullRequests: [],
    });
    expect(issues[0]?.externalLink).toBe("https://mail.test/thread/1");
    expect(issues[0]?.externalSource).toBe("support_email");
    expect(issues[0]?.hasSlack).toBe(false);
    expect(issues[0]?.worktreeOrigin).toBe("manual");
  });

  it("prefers an open PR over a closed one for the same branch", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [thread({ id: "t1", projectId: "proj-a", branch: "dup", worktreePath: "/wt/d" })],
      pullRequests: [
        pr({ cwd: "/repo/a", number: 1, headRefName: "dup", state: "closed" }),
        pr({ cwd: "/repo/a", number: 2, headRefName: "dup", state: "open" }),
      ],
    });
    const matched = issues.find((issue) => issue.thread?.id === "t1");
    expect(matched?.pullRequest?.number).toBe(2);
    expect(matched?.status).toBe("ready");
  });
});

describe("filterIssues and sortIssues", () => {
  const projectA = project("proj-a", "/repo/a");
  const base = buildDashboardIssues({
    projects: [projectA],
    threads: [
      thread({
        id: "t1",
        projectId: "proj-a",
        branch: "a",
        worktreePath: "/wt/a",
        updatedAt: "2026-01-03T00:00:00.000Z",
        slackUrl: "https://slack.test/x",
      }),
      thread({
        id: "t2",
        projectId: "proj-a",
        branch: "b",
        worktreePath: null,
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ],
    pullRequests: [
      pr({
        cwd: "/repo/a",
        number: 5,
        headRefName: "b",
        state: "merged",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    ],
  });

  it("filters by status, has-worktree and has-slack", () => {
    const onlyWorktree: DashboardFilters = { statuses: [], hasWorktree: true, hasSlack: false };
    expect(filterIssues(base, onlyWorktree).every((issue) => issue.hasWorktree)).toBe(true);

    const onlySlack: DashboardFilters = { statuses: [], hasWorktree: false, hasSlack: true };
    const slackIssues = filterIssues(base, onlySlack);
    expect(slackIssues).toHaveLength(1);
    expect(slackIssues[0]?.hasSlack).toBe(true);

    const onlyMerged: DashboardFilters = {
      statuses: ["merged"],
      hasWorktree: false,
      hasSlack: false,
    };
    expect(filterIssues(base, onlyMerged).every((issue) => issue.status === "merged")).toBe(true);
  });

  it("sorts by updated time in both directions", () => {
    const desc = sortIssues(base, "updated", "desc");
    const asc = sortIssues(base, "updated", "asc");
    expect(desc[0]?.updatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(asc[0]?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});
