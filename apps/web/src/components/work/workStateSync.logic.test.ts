import { describe, expect, it } from "vite-plus/test";

import {
  applyServerSnapshot,
  decideWorkStateMigration,
  rebaseWorkState,
  replayWorkOperations,
} from "./workStateSync.logic";
import {
  createFolder,
  fileThreads,
  initialWorkModeData,
  type WorkModeData,
} from "../../workModeStore";

const createdAt = "2026-10-01T00:00:00.000Z";

function localData(): WorkModeData {
  let data = createFolder(initialWorkModeData, {
    id: "local",
    name: "Local",
    parentId: null,
    createdAt,
  });
  data = fileThreads(data, ["env:thread"], "local");
  return { ...data, collapsedFolderIds: ["local", "gone"] };
}

describe("Work state sync logic", () => {
  it("sanitizes server snapshots and prunes collapsed folders", () => {
    const result = applyServerSnapshot(localData(), {
      folders: [
        { id: "server", name: "Server", parentId: null, createdAt },
        { id: "bad", name: "Bad", parentId: null },
      ],
      threadFolderByKey: { "env:thread": "missing", "env:other": "server" },
    });
    expect(result.folders.map((folder) => folder.id)).toEqual(["server"]);
    expect(result.threadFolderByKey).toEqual({ "env:other": "server" });
    expect(result.collapsedFolderIds).toEqual([]);
  });

  it("replays local reducer operations after a conflict", () => {
    const base = createFolder(initialWorkModeData, {
      id: "server",
      name: "Server",
      parentId: null,
      createdAt,
    });
    const operations = [
      { type: "createFolder", input: { id: "local", name: "Local", parentId: null, createdAt } },
      { type: "fileThreads", threadKeys: ["env:thread"], projectId: "local" },
    ] as const;
    const result = replayWorkOperations(base, operations);
    expect(result.folders.map((folder) => folder.id)).toEqual(["server", "local"]);
    expect(result.threadFolderByKey).toEqual({ "env:thread": "local" });
    expect(rebaseWorkState(initialWorkModeData, base, operations)).toEqual(result);
  });

  it("migrates local data to an empty target", () => {
    expect(
      decideWorkStateMigration({
        serverVersion: 0,
        serverData: null,
        localData: localData(),
        hasSynced: false,
      }),
    ).toBe("upload-local");
    expect(
      decideWorkStateMigration({
        serverVersion: 0,
        serverData: null,
        localData: initialWorkModeData,
        hasSynced: false,
      }),
    ).toBe("apply-server");
  });

  it("lets a non-empty server win on first sync, except empty-server folders", () => {
    expect(
      decideWorkStateMigration({
        serverVersion: 4,
        serverData: { folders: [{ id: "server", name: "Server", parentId: null, createdAt }] },
        localData: localData(),
        hasSynced: false,
      }),
    ).toBe("apply-server");
    expect(
      decideWorkStateMigration({
        serverVersion: 2,
        serverData: { folders: [], threadFolderByKey: {} },
        localData: localData(),
        hasSynced: false,
      }),
    ).toBe("upload-local");
  });
});
