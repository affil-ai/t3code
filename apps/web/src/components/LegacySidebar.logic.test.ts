import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  archiveSelectedThreadEntries,
  resolveProjectStatusIndicator,
  sortProjectsForSidebar,
} from "./LegacySidebar.logic";

describe("archiveSelectedThreadEntries", () => {
  const entries = [{ threadKey: "one" }, { threadKey: "two" }, { threadKey: "three" }] as const;
  const success = { _tag: "Success" } as const;
  const failure = { _tag: "Failure" } as const;

  it("stops at a mutation failure and retains prior successes", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      if (entry.threadKey === "two") return failure;
      onArchived();
      return success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one"],
      mutationFailure: failure,
      followupFailures: [],
    });
  });

  it("continues after a post-archive failure", async () => {
    const archive = vi.fn(async (entry: (typeof entries)[number], onArchived: () => void) => {
      onArchived();
      return entry.threadKey === "two" ? failure : success;
    });
    const outcome = await archiveSelectedThreadEntries({ entries, archive });

    expect(archive).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({
      archivedThreadKeys: ["one", "two", "three"],
      mutationFailure: null,
      followupFailures: [failure],
    });
  });
});

describe("resolveProjectStatusIndicator", () => {
  it("ranks waiting below active work and above plan-ready", () => {
    const waiting = {
      label: "Waiting" as const,
      colorClass: "text-sidebar-muted-foreground",
      dotClass: "bg-sidebar-muted-foreground",
      pulse: false,
    };

    expect(
      resolveProjectStatusIndicator([
        waiting,
        {
          label: "Working",
          colorClass: "text-sky-600",
          dotClass: "bg-sky-500",
          pulse: true,
        },
      ]),
    ).toMatchObject({ label: "Working" });
    expect(
      resolveProjectStatusIndicator([
        {
          label: "Plan Ready",
          colorClass: "text-violet-600",
          dotClass: "bg-violet-500",
          pulse: false,
        },
        waiting,
      ]),
    ).toMatchObject({ label: "Waiting" });
  });
});

describe("sortProjectsForSidebar", () => {
  it("sorts projects by the most recent user message across their threads", () => {
    const projects = [
      { id: ProjectId.make("project-1"), title: "Older project" },
      { id: ProjectId.make("project-2"), title: "Newer project" },
    ];
    const userMessage = (createdAt: string) => ({ role: "user", createdAt });
    const threads = [
      {
        projectId: ProjectId.make("project-1"),
        createdAt: "2026-03-09T10:00:00.000Z",
        updatedAt: "2026-03-09T10:20:00.000Z",
        messages: [userMessage("2026-03-09T10:01:00.000Z")],
      },
      {
        projectId: ProjectId.make("project-2"),
        createdAt: "2026-03-09T10:00:00.000Z",
        updatedAt: "2026-03-09T10:05:00.000Z",
        messages: [userMessage("2026-03-09T10:05:00.000Z")],
      },
    ];

    const sorted = sortProjectsForSidebar(projects, threads, "updated_at");

    expect(sorted.map((project) => project.id)).toEqual([
      ProjectId.make("project-2"),
      ProjectId.make("project-1"),
    ]);
  });
});
