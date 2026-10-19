import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkFolderTree,
  createFolder,
  deleteFolder,
  initialWorkModeData,
  moveFolder,
  fileThreads,
  renameFolder,
  reorderFolder,
  resolveThreadWorkProjectId,
  type WorkModeData,
} from "./workModeStore";

const createdAt = "2026-09-24T00:00:00.000Z";

function withFolders(): WorkModeData {
  let data = createFolder(initialWorkModeData, {
    id: "a",
    name: "Clients",
    parentId: null,
    createdAt,
  });
  data = createFolder(data, { id: "b", name: "Acme", parentId: "a", createdAt });
  data = createFolder(data, { id: "c", name: "Q3", parentId: "b", createdAt });
  return data;
}

describe("work folders", () => {
  it("creates nested folders and ignores blank names or missing parents", () => {
    const data = withFolders();
    expect(data.folders.map((folder) => folder.id)).toEqual(["a", "b", "c"]);
    expect(createFolder(data, { id: "d", name: "   ", parentId: null, createdAt })).toBe(data);
    expect(createFolder(data, { id: "d", name: "X", parentId: "missing", createdAt })).toBe(data);
  });

  it("renames a folder with normalized whitespace", () => {
    const data = renameFolder(withFolders(), "b", "  Acme   Corp ");
    expect(data.folders.find((folder) => folder.id === "b")?.name).toBe("Acme Corp");
  });

  it("refuses to move a folder into its own subtree", () => {
    const data = withFolders();
    expect(moveFolder(data, "a", "c")).toBe(data);
    expect(moveFolder(data, "a", "a")).toBe(data);
    expect(moveFolder(data, "c", null).folders.find((folder) => folder.id === "c")?.parentId).toBe(
      null,
    );
  });

  it("moves a deleted project's chats to its parent, then back to Chats", () => {
    let data = withFolders();
    data = fileThreads(data, ["env:t1"], "b");
    data = fileThreads(data, ["env:t2"], "a");
    data = deleteFolder(data, "b");
    expect(data.folders.find((folder) => folder.id === "c")?.parentId).toBe("a");
    expect(data.threadFolderByKey).toEqual({ "env:t1": "a", "env:t2": "a" });

    data = deleteFolder(data, "a");
    expect(data.threadFolderByKey).toEqual({});
    expect(data.folders.find((folder) => folder.id === "c")?.parentId).toBe(null);
  });

  it("files threads in projects and returns them to Chats", () => {
    let data = fileThreads(withFolders(), ["env:t1", "env:t2"], "c");
    expect(resolveThreadWorkProjectId(data, "env:t1")).toBe("c");
    data = fileThreads(data, ["env:t1"], null);
    expect(resolveThreadWorkProjectId(data, "env:t1")).toBe(null);
    expect(fileThreads(data, ["env:t2"], "missing")).toBe(data);
    expect(fileThreads(data, ["env:t1"], null)).toBe(data);
  });

  it("shows a thread filed in an unknown project under Chats", () => {
    const data = { ...withFolders(), threadFolderByKey: { "env:t1": "gone" } };
    expect(resolveThreadWorkProjectId(data, "env:t1")).toBe(null);
  });

  it("builds the tree in the user's order and lifts orphans to the top level", () => {
    let data = withFolders();
    data = createFolder(data, { id: "d", name: "Admin", parentId: null, createdAt });
    data = {
      ...data,
      folders: [...data.folders, { id: "e", name: "Orphan", parentId: "gone", createdAt }],
    };
    const tree = buildWorkFolderTree(data.folders);
    expect(tree.map((node) => node.folder.name)).toEqual(["Clients", "Admin", "Orphan"]);
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  it("reorders projects before or after a sibling and refuses cycles", () => {
    let data = withFolders();
    data = createFolder(data, { id: "d", name: "Admin", parentId: null, createdAt });
    data = reorderFolder(data, "d", "a", "before");
    expect(buildWorkFolderTree(data.folders).map((node) => node.folder.id)).toEqual(["d", "a"]);
    data = reorderFolder(data, "d", "a", "after");
    expect(buildWorkFolderTree(data.folders).map((node) => node.folder.id)).toEqual(["a", "d"]);
    expect(reorderFolder(data, "d", "a", "after")).toBe(data);
    expect(reorderFolder(data, "a", "c", "before")).toBe(data);
  });
});
