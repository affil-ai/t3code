import { describe, expect, it } from "vite-plus/test";

import { createFolder, fileThreads, initialWorkModeData } from "../../workModeStore";
import {
  parseThreadParentMarker,
  resolveParentWorkProjectId,
  selectThreadParentCandidates,
  stripThreadParentMarker,
  THREAD_PARENT_CHECK_WINDOW_MS,
} from "./threadParent.logic";

const createdAt = "2026-09-25T00:00:00.000Z";
const now = Date.parse(createdAt) + 60_000;

function filedData() {
  let data = createFolder(initialWorkModeData, {
    id: "machine",
    name: "Machine",
    parentId: null,
    createdAt,
  });
  data = createFolder(data, { id: "other", name: "Other", parentId: null, createdAt });
  data = fileThreads(data, ["mac:parent-1"], "machine");
  return fileThreads(data, ["ubuntu:parent-1"], "other");
}

describe("parent marker", () => {
  it("reads the parent thread ID at the start of the message", () => {
    expect(parseThreadParentMarker("<!-- t3work-parent: abc-123 -->\nDo the thing")).toBe(
      "abc-123",
    );
    expect(parseThreadParentMarker("  <!--t3work-parent:abc-->Do it")).toBe("abc");
  });

  it("ignores a marker that is not at the start", () => {
    expect(parseThreadParentMarker("Do it\n<!-- t3work-parent: abc -->")).toBeNull();
    expect(parseThreadParentMarker("Do the thing")).toBeNull();
  });

  it("strips only the leading marker and its line break", () => {
    expect(stripThreadParentMarker("<!-- t3work-parent: abc -->\nDo the thing")).toBe(
      "Do the thing",
    );
    expect(stripThreadParentMarker("Keep <!-- t3work-parent: abc --> this")).toBe(
      "Keep <!-- t3work-parent: abc --> this",
    );
  });
});

describe("resolveParentWorkProjectId", () => {
  it("prefers the parent in the child's own environment", () => {
    expect(resolveParentWorkProjectId(filedData(), "ubuntu", "parent-1")).toBe("other");
    expect(resolveParentWorkProjectId(filedData(), "mac", "parent-1")).toBe("machine");
  });

  it("falls back to the parent in another environment", () => {
    expect(resolveParentWorkProjectId(filedData(), "laptop", "parent-1")).not.toBeNull();
  });

  it("returns null for an unfiled or unknown parent", () => {
    expect(resolveParentWorkProjectId(filedData(), "mac", "missing")).toBeNull();
  });
});

describe("selectThreadParentCandidates", () => {
  const base = { createdAt, archivedAt: null, latestUserMessageAt: createdAt };

  it("keeps recent unfiled chats with a message, oldest first", () => {
    const candidates = selectThreadParentCandidates(
      [
        { ...base, key: "mac:b", createdAt: "2026-09-25T00:00:30.000Z" },
        { ...base, key: "mac:a" },
        { ...base, key: "mac:parent-1" },
        { ...base, key: "mac:archived", archivedAt: createdAt },
        { ...base, key: "mac:empty", latestUserMessageAt: null },
        { ...base, key: "mac:checked" },
        {
          ...base,
          key: "mac:old",
          createdAt: new Date(now - THREAD_PARENT_CHECK_WINDOW_MS - 1).toISOString(),
        },
      ],
      filedData(),
      new Set(["mac:checked"]),
      now,
    );
    expect(candidates.map((thread) => thread.key)).toEqual(["mac:a", "mac:b"]);
  });
});
