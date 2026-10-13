import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { officeFolders } from "./officeGroups";
const entry = {
  environmentId: EnvironmentId.make("host"),
  threadId: ThreadId.make("one"),
  officeChatId: "chat",
  workspaceId: "team",
  conversationId: "C123",
  conversationType: "channel",
  label: "#engineering",
} as const;
describe("Office folders", () => {
  it("groups Slack threads by conversation while keeping environments and workspaces separate", () => {
    const result = officeFolders([
      entry,
      { ...entry, threadId: ThreadId.make("two") },
      { ...entry, environmentId: EnvironmentId.make("other") },
      { ...entry, threadId: ThreadId.make("three"), workspaceId: "other" },
    ]);
    expect(result.folders).toHaveLength(3);
    expect(
      Object.values(result.threadFolderByKey).filter((id) => id === result.folders[0]?.id),
    ).toHaveLength(2);
  });
  it("keeps the group identity across a channel rename", () => {
    expect(officeFolders([entry]).folders[0]?.id).toBe(
      officeFolders([{ ...entry, label: "#renamed" }]).folders[0]?.id,
    );
  });
  it("groups non-Slack chats separately and never seeds groups", () => {
    expect(officeFolders([])).toEqual({ folders: [], threadFolderByKey: {} });
    expect(
      officeFolders([
        {
          ...entry,
          conversationId: null,
          workspaceId: null,
          conversationType: "other",
          label: "Other chats",
        },
      ]).folders[0]?.name,
    ).toBe("Other chats");
  });
});
