import { describe, expect, it } from "vite-plus/test";
import type { GitListedPullRequest } from "@t3tools/contracts";

import {
  buildDashboardIssues,
  dashboardProjectFilterKey,
  deriveIssueStatus,
  filterIssues,
  hasDevinBranchPrefix,
  inferWorktreeOrigin,
  normalizeBranchKey,
  resolveProjectBadgeLabel,
  sortIssues,
  type DashboardFilters,
  type DashboardPullRequest,
} from "./dashboardIssues";
import type { Project, SidebarThreadSummary } from "./types";

const ENV = "env-1";
const REMOTE_ENV = "env-remote";

function project(id: string, cwd: string, displayName?: string, environmentId = ENV): Project {
  return {
    id: id as Project["id"],
    environmentId: environmentId as Project["environmentId"],
    name: id,
    cwd,
    ...(displayName
      ? {
          repositoryIdentity: {
            canonicalKey: `github.com/${displayName}`,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: `https://github.com/${displayName}.git`,
            },
            displayName,
          },
        }
      : {}),
    defaultModelSelection: null,
    scripts: [],
  };
}

function thread(input: {
  id: string;
  projectId: string;
  environmentId?: string;
  branch: string | null;
  worktreePath?: string | null;
  createdAt?: string;
  updatedAt?: string;
  slackUrl?: string;
  externalSource?: string;
  hasExternalThreadLink?: boolean;
  externalLink?: { url: string; source: string | null };
}): SidebarThreadSummary {
  return {
    id: input.id as SidebarThreadSummary["id"],
    environmentId: (input.environmentId ?? ENV) as SidebarThreadSummary["environmentId"],
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
      : input.externalSource
        ? { externalThreadLink: { muted: false, source: input.externalSource } }
        : input.hasExternalThreadLink
          ? { externalThreadLink: { muted: false } }
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

describe("hasDevinBranchPrefix", () => {
  it("detects Devin branch prefixes", () => {
    expect(hasDevinBranchPrefix("devin/fix-dashboard")).toBe(true);
    expect(hasDevinBranchPrefix("Devin/update-copy")).toBe(true);
    expect(hasDevinBranchPrefix("devin-fix-dashboard")).toBe(true);
    expect(hasDevinBranchPrefix("feature/devin-fix-dashboard")).toBe(false);
    expect(hasDevinBranchPrefix("devinfix-dashboard")).toBe(false);
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
        hasExternalThreadLink: true,
        matchedPullRequest: false,
      }),
    ).toBe("slack");
    expect(
      inferWorktreeOrigin({
        hasWorktree: true,
        externalSource: null,
        hasExternalThreadLink: false,
        matchedPullRequest: true,
      }),
    ).toBe("pull-request");
    expect(
      inferWorktreeOrigin({
        hasWorktree: true,
        externalSource: null,
        hasExternalThreadLink: false,
        matchedPullRequest: false,
      }),
    ).toBe("manual");
    expect(
      inferWorktreeOrigin({
        hasWorktree: true,
        externalSource: null,
        hasExternalThreadLink: true,
        matchedPullRequest: false,
      }),
    ).toBe("slack");
    expect(
      inferWorktreeOrigin({
        hasWorktree: false,
        externalSource: "slack",
        hasExternalThreadLink: true,
        matchedPullRequest: true,
      }),
    ).toBe("none");
  });
});

describe("resolveProjectBadgeLabel", () => {
  it("prefers repository identity display name over the local project name", () => {
    expect(resolveProjectBadgeLabel(project("local-name", "/repo/a", "affil-ai/t3code"))).toBe(
      "affil-ai/t3code",
    );
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

  it("flags issues whose branch has a Devin prefix", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [
        thread({
          id: "t1",
          projectId: "proj-a",
          branch: "devin/fix-dashboard",
          worktreePath: "/wt/devin-fix-dashboard",
        }),
        thread({
          id: "t2",
          projectId: "proj-a",
          branch: "feature/devin-fix-dashboard",
          worktreePath: "/wt/feature-devin-fix-dashboard",
        }),
      ],
      pullRequests: [],
    });

    expect(issues.find((issue) => issue.thread?.id === "t1")?.hasDevin).toBe(true);
    expect(issues.find((issue) => issue.thread?.id === "t2")?.hasDevin).toBe(false);
  });

  it("joins generated branch variants within the same project", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [
        thread({
          id: "t1",
          projectId: "proj-a",
          branch: "t3code/affiliate-settings-scrapes",
          worktreePath: "/wt/affiliate-settings-scrapes",
        }),
      ],
      pullRequests: [
        pr({
          cwd: "/repo/a",
          number: 460,
          headRefName: "t3code/affiliate-settings-scrape-update",
          state: "open",
        }),
      ],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.status).toBe("ready");
    expect(issues[0]?.pullRequest?.number).toBe(460);
    expect(issues[0]?.thread?.id).toBe("t1");
  });

  it("joins cloud worktrees to local PRs from the same repository", () => {
    const localProject = project("local-affil", "/repo/affil", "affil-ai/affil", ENV);
    const cloudProject = project("cloud-affil", "/cloud/affil", "affil-ai/affil", REMOTE_ENV);
    const issues = buildDashboardIssues({
      projects: [localProject, cloudProject],
      threads: [
        thread({
          id: "cloud-thread",
          environmentId: REMOTE_ENV,
          projectId: "cloud-affil",
          branch: "t3code/affiliate-settings-scrapes",
          worktreePath: "/cloud/wt/affiliate-settings-scrapes",
          externalSource: "slack",
        }),
      ],
      pullRequests: [
        {
          ...pr({
            cwd: "/repo/affil",
            number: 460,
            headRefName: "t3code/affiliate-settings-scrape-update",
            state: "open",
          }),
          environmentId: ENV as DashboardPullRequest["environmentId"],
        },
      ],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.status).toBe("ready");
    expect(issues[0]?.project?.id).toBe("cloud-affil");
    expect(issues[0]?.thread?.id).toBe("cloud-thread");
    expect(issues[0]?.pullRequest?.number).toBe(460);
    expect(issues[0]?.hasSlack).toBe(true);
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

  it("does not join broad branch-token overlaps within a project", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [
        thread({
          id: "t1",
          projectId: "proj-a",
          branch: "t3code/affiliate-settings-update",
          worktreePath: "/wt/affiliate-settings-update",
        }),
      ],
      pullRequests: [
        pr({
          cwd: "/repo/a",
          number: 461,
          headRefName: "t3code/affiliate-settings-scrape-update",
          state: "open",
        }),
      ],
    });

    const threadIssue = issues.find((issue) => issue.thread?.id === "t1");
    const prIssue = issues.find((issue) => issue.pullRequest?.number === 461);
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

  it("marks remote slack-derived worktrees even when the snapshot has no permalink", () => {
    const remoteProject = project("proj-remote", "/repo/remote", "affil-ai/t3code", REMOTE_ENV);
    const issues = buildDashboardIssues({
      projects: [remoteProject],
      threads: [
        thread({
          id: "remote-slack-thread",
          environmentId: REMOTE_ENV,
          projectId: "proj-remote",
          branch: "from-slack",
          worktreePath: "/remote/wt/s",
          externalSource: "slack",
        }),
      ],
      pullRequests: [],
    });

    expect(issues[0]?.worktreeOrigin).toBe("slack");
    expect(issues[0]?.hasSlack).toBe(true);
    expect(issues[0]?.externalLink).toBeNull();
    expect(issues[0]?.externalSource).toBe("slack");
  });

  it("treats legacy remote external thread links as Slack when source is missing", () => {
    const remoteProject = project("proj-remote", "/repo/remote", "affil-ai/t3code", REMOTE_ENV);
    const issues = buildDashboardIssues({
      projects: [remoteProject],
      threads: [
        thread({
          id: "legacy-remote-slack-thread",
          environmentId: REMOTE_ENV,
          projectId: "proj-remote",
          branch: "from-legacy-slack",
          worktreePath: "/remote/wt/legacy",
          hasExternalThreadLink: true,
        }),
      ],
      pullRequests: [],
    });

    expect(issues[0]?.worktreeOrigin).toBe("slack");
    expect(issues[0]?.hasSlack).toBe(true);
    expect(issues[0]?.externalLink).toBeNull();
    expect(issues[0]?.externalSource).toBeNull();
  });

  it("surfaces worktree threads from remote projects with colliding local project ids", () => {
    const localProject = project("proj-shared", "/repo/shared", "affil-ai/t3code", ENV);
    const remoteProject = project("proj-shared", "/repo/shared", "affil-ai/t3code", REMOTE_ENV);
    const issues = buildDashboardIssues({
      projects: [localProject, remoteProject],
      threads: [
        thread({
          id: "remote-thread",
          environmentId: REMOTE_ENV,
          projectId: "proj-shared",
          branch: "remote-work",
          worktreePath: "/remote/wt",
        }),
      ],
      pullRequests: [],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.thread?.environmentId).toBe(REMOTE_ENV);
    expect(issues[0]?.project?.environmentId).toBe(REMOTE_ENV);
    expect(issues[0]?.status).toBe("worktree-only");
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
    const onlyWorktree: DashboardFilters = {
      statuses: [],
      projectIds: [],
      searchQuery: "",
      hasWorktree: true,
      hasSlack: false,
    };
    expect(filterIssues(base, onlyWorktree).every((issue) => issue.hasWorktree)).toBe(true);

    const onlySlack: DashboardFilters = {
      statuses: [],
      projectIds: [],
      searchQuery: "",
      hasWorktree: false,
      hasSlack: true,
    };
    const slackIssues = filterIssues(base, onlySlack);
    expect(slackIssues).toHaveLength(1);
    expect(slackIssues[0]?.hasSlack).toBe(true);

    const onlyMerged: DashboardFilters = {
      statuses: ["merged"],
      projectIds: [],
      searchQuery: "",
      hasWorktree: false,
      hasSlack: false,
    };
    expect(filterIssues(base, onlyMerged).every((issue) => issue.status === "merged")).toBe(true);
  });

  it("filters by Devin branch prefix", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [
        thread({
          id: "devin-thread",
          projectId: "proj-a",
          branch: "devin/fix-dashboard",
          worktreePath: "/wt/devin",
        }),
        thread({
          id: "manual-thread",
          projectId: "proj-a",
          branch: "feature/fix-dashboard",
          worktreePath: "/wt/manual",
        }),
      ],
      pullRequests: [],
    });

    const filtered = filterIssues(issues, {
      statuses: [],
      projectIds: [],
      searchQuery: "",
      hasWorktree: false,
      hasSlack: false,
      hasDevin: true,
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.thread?.id).toBe("devin-thread");
  });

  it("hides closed PR issues that have not been updated in seven days", () => {
    const issues = buildDashboardIssues({
      projects: [projectA],
      threads: [],
      pullRequests: [
        pr({
          cwd: "/repo/a",
          number: 10,
          headRefName: "stale-closed",
          state: "closed",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
        pr({
          cwd: "/repo/a",
          number: 11,
          headRefName: "recent-closed",
          state: "closed",
          updatedAt: "2026-01-05T00:00:00.000Z",
        }),
        pr({
          cwd: "/repo/a",
          number: 12,
          headRefName: "old-merged",
          state: "merged",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
    });

    const filtered = filterIssues(
      issues,
      {
        statuses: [],
        projectIds: [],
        searchQuery: "",
        hasWorktree: false,
        hasSlack: false,
      },
      { nowMs: new Date("2026-01-10T00:00:00.000Z").getTime() },
    );

    expect(filtered.map((issue) => issue.pullRequest?.number)).toEqual([11, 12]);
  });

  it("filters by selected projects and global search terms", () => {
    const projectB = project("proj-b", "/repo/b", "affil-ai/t3code");
    const issues = buildDashboardIssues({
      projects: [projectA, projectB],
      threads: [
        thread({ id: "t1", projectId: "proj-a", branch: "alpha", worktreePath: "/wt/a" }),
        thread({
          id: "t2",
          projectId: "proj-b",
          branch: "dashboard-search",
          worktreePath: "/wt/b",
        }),
      ],
      pullRequests: [
        pr({
          cwd: "/repo/b",
          number: 31,
          headRefName: "dashboard-search",
          state: "open",
          updatedAt: "2026-01-04T00:00:00.000Z",
        }),
      ],
    });

    const filtered = filterIssues(issues, {
      statuses: [],
      projectIds: ["proj-b"],
      searchQuery: "affil-ai #31 dashboard",
      hasWorktree: false,
      hasSlack: false,
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.project?.id).toBe("proj-b");
    expect(filtered[0]?.pullRequest?.number).toBe(31);
  });

  it("filters projects by scoped environment/project key", () => {
    const localProject = project("proj-shared", "/repo/local", "affil-ai/t3code", ENV);
    const remoteProject = project("proj-shared", "/repo/remote", "affil-ai/t3code", REMOTE_ENV);
    const issues = buildDashboardIssues({
      projects: [localProject, remoteProject],
      threads: [
        thread({
          id: "local-thread",
          projectId: "proj-shared",
          branch: "local",
          worktreePath: "/wt/local",
        }),
        thread({
          id: "remote-thread",
          environmentId: REMOTE_ENV,
          projectId: "proj-shared",
          branch: "remote",
          worktreePath: "/wt/remote",
        }),
      ],
      pullRequests: [],
    });

    const filtered = filterIssues(issues, {
      statuses: [],
      projectIds: [dashboardProjectFilterKey(remoteProject)],
      searchQuery: "",
      hasWorktree: false,
      hasSlack: false,
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.thread?.id).toBe("remote-thread");
  });

  it("sorts by updated time in both directions", () => {
    const desc = sortIssues(base, "updated", "desc");
    const asc = sortIssues(base, "updated", "asc");
    expect(desc[0]?.updatedAt).toBe("2026-01-03T00:00:00.000Z");
    expect(asc[0]?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
  });
});
