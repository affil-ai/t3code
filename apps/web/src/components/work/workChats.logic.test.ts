import type { EnvironmentId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../../types";
import { initialWorkModeData, useWorkModeStore } from "../../workModeStore";
import {
  resolveWorkChatRepositoryKey,
  applyWorkThreadMenuAction,
  buildWorkThreadMenuItems,
  groupWorkThreads,
} from "./workChats.logic";

const environmentId = "env-1" as EnvironmentId;
const createdAt = "2026-09-01T00:00:00.000Z";
const projects = [
  { id: "p1", name: "Clients", parentId: null, createdAt },
  { id: "p2", name: "Acme", parentId: "p1", createdAt },
];

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId,
    title: id,
    archivedAt: null,
    createdAt,
    updatedAt: createdAt,
    latestUserMessageAt: null,
    ...overrides,
  } as SidebarThreadSummary;
}

afterEach(() => {
  useWorkModeStore.setState({ ...initialWorkModeData, editingFolderId: null });
});

describe("groupWorkThreads", () => {
  it("puts filed threads in their project and everything else in Chats", () => {
    const groups = groupWorkThreads(
      [thread("a"), thread("b"), thread("c"), thread("d", { archivedAt: createdAt })],
      { folders: projects, threadFolderByKey: { "env-1:a": "p2", "env-1:b": "gone" } },
      "updated_at",
    );
    expect(groups.byProjectId.get("p2")?.map((entry) => entry.id)).toEqual(["a"]);
    expect(groups.chats.map((entry) => entry.id).toSorted()).toEqual(["b", "c"]);
  });

  it("keeps lineage threads out of both Projects and Chats", () => {
    const groups = groupWorkThreads(
      [
        thread("root"),
        thread("subagent", {
          lineage: {
            rootThreadId: ThreadId.make("root"),
            parentThreadId: ThreadId.make("root"),
            relationshipToParent: "subagent",
          },
        }),
        thread("fork", {
          lineage: {
            rootThreadId: ThreadId.make("root"),
            parentThreadId: ThreadId.make("root"),
            relationshipToParent: "fork",
          },
        }),
      ],
      {
        folders: projects,
        threadFolderByKey: { "env-1:subagent": "p1", "env-1:fork": "p2" },
      },
      "updated_at",
    );

    expect(groups.byProjectId.get("p1")).toBeUndefined();
    expect(groups.byProjectId.get("p2")).toBeUndefined();
    expect(groups.chats.map((entry) => entry.id)).toEqual(["root"]);
  });
});

describe("buildWorkThreadMenuItems", () => {
  it("offers projects for a chat", () => {
    const items = buildWorkThreadMenuItems({ folders: projects, threadFolderByKey: {} }, [
      "env-1:a",
    ]);
    expect(items.map((item) => item.label)).toEqual(["Move to project"]);
    expect(items[0]?.children?.map((item) => item.label.trim())).toEqual([
      "Clients",
      "Acme",
      "New project",
    ]);
  });

  it("offers removal for a filed thread and hides its current project", () => {
    const items = buildWorkThreadMenuItems(
      { folders: projects, threadFolderByKey: { "env-1:a": "p2" } },
      ["env-1:a"],
    );
    expect(items.map((item) => item.label)).toEqual(["Move to project", "Remove from project"]);
    expect(items[0]?.children?.map((item) => item.label.trim())).toEqual([
      "Clients",
      "New project",
    ]);
  });

  it("offers a new project directly when none exist", () => {
    const items = buildWorkThreadMenuItems({ folders: [], threadFolderByKey: {} }, ["env-1:a"]);
    expect(items.map((item) => item.label)).toEqual(["Move to new project"]);
  });
});

describe("applyWorkThreadMenuAction", () => {
  it("files and removes threads and ignores other ids", () => {
    useWorkModeStore.setState({ folders: projects });
    expect(applyWorkThreadMenuAction("rename", ["env-1:a"])).toBe(false);
    expect(applyWorkThreadMenuAction("work:project:p1", ["env-1:a"])).toBe(true);
    expect(useWorkModeStore.getState().threadFolderByKey).toEqual({ "env-1:a": "p1" });
    applyWorkThreadMenuAction("work:remove-from-project", ["env-1:a"]);
    expect(useWorkModeStore.getState().threadFolderByKey).toEqual({});
  });

  it("creates a project, files the threads, and starts renaming it", () => {
    applyWorkThreadMenuAction("work:new-project", ["env-1:a"]);
    const state = useWorkModeStore.getState();
    expect(state.folders).toHaveLength(1);
    expect(state.threadFolderByKey["env-1:a"]).toBe(state.folders[0]?.id);
    expect(state.editingFolderId).toBe(state.folders[0]?.id);
  });
});

describe("resolveWorkChatRepositoryKey", () => {
  const keyOf = (environmentId: string, projectId: string) => `${environmentId}:${projectId}`;
  const projectKeys = new Set(["env:a", "env:b", "env:c"]);
  const threads = [
    {
      environmentId: "env",
      projectId: "a",
      updatedAt: "2026-10-01T00:00:00Z",
      latestUserMessageAt: null,
    },
    {
      environmentId: "env",
      projectId: "b",
      updatedAt: "2026-10-01T00:00:00Z",
      latestUserMessageAt: "2026-10-05T00:00:00Z",
    },
    {
      environmentId: "env",
      projectId: "gone",
      updatedAt: "2026-10-09T00:00:00Z",
      latestUserMessageAt: null,
    },
  ] as never;

  it("prefers the open chat's repository, then the saved default", () => {
    const base = { projectKeys, threads, scopedProjectKey: keyOf };
    expect(
      resolveWorkChatRepositoryKey({
        ...base,
        activeProjectKey: "env:c",
        defaultProjectKey: "env:a",
      }),
    ).toBe("env:c");
    expect(
      resolveWorkChatRepositoryKey({ ...base, activeProjectKey: null, defaultProjectKey: "env:a" }),
    ).toBe("env:a");
  });

  it("falls back to the most recently used existing repository, then any", () => {
    expect(
      resolveWorkChatRepositoryKey({
        activeProjectKey: "env:gone",
        defaultProjectKey: "env:missing",
        projectKeys,
        threads,
        scopedProjectKey: keyOf,
      }),
    ).toBe("env:b");
    expect(
      resolveWorkChatRepositoryKey({
        activeProjectKey: null,
        defaultProjectKey: null,
        projectKeys: new Set(["env:only"]),
        threads: [],
        scopedProjectKey: keyOf,
      }),
    ).toBe("env:only");
    expect(
      resolveWorkChatRepositoryKey({
        activeProjectKey: null,
        defaultProjectKey: null,
        projectKeys: new Set(),
        threads: [],
        scopedProjectKey: keyOf,
      }),
    ).toBeNull();
  });
});
