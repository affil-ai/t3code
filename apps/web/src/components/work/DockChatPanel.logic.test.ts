import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DOCK_OTHER_CHATS_LIMIT, sectionDockChatCandidates } from "./DockChatPanel.logic";

const mac = EnvironmentId.make("env-mac");
const ubuntu = EnvironmentId.make("env-ubuntu");

function thread(
  environmentId: EnvironmentId,
  id: string,
  projectId: string,
  updatedAt: string,
  archivedAt: string | null = null,
): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: id,
    updatedAt,
    latestUserMessageAt: null,
    archivedAt,
  } as unknown as EnvironmentThreadShell;
}

const hostThreadRef = scopeThreadRef(mac, ThreadId.make("host"));
const keyOf = (shell: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id));

describe("sectionDockChatCandidates", () => {
  it("orders Work project, then repo, then everything else, each chat once", () => {
    const filedOnUbuntu = thread(ubuntu, "filed-ubuntu", "other-repo", "2026-09-25T10:00:00Z");
    const filedInRepo = thread(mac, "filed-repo", "repo", "2026-09-25T09:00:00Z");
    const repoChat = thread(mac, "repo-chat", "repo", "2026-09-25T11:00:00Z");
    const sameIdOtherMachine = thread(ubuntu, "repo-chat-2", "repo", "2026-09-25T08:00:00Z");
    const archived = thread(
      mac,
      "archived",
      "repo",
      "2026-09-25T12:00:00Z",
      "2026-09-25T12:30:00Z",
    );
    const host = thread(mac, "host", "repo", "2026-09-25T13:00:00Z");

    const sections = sectionDockChatCandidates({
      threads: [filedOnUbuntu, filedInRepo, repoChat, sameIdOtherMachine, archived, host],
      hostThreadRef,
      hostProjectId: "repo",
      repoTitle: "machine",
      workProject: {
        name: "Affil Ops",
        threadKeys: new Set([keyOf(filedOnUbuntu), keyOf(filedInRepo)]),
      },
    });

    expect(sections.map((section) => [section.title, section.threads.map((t) => t.id)])).toEqual([
      ["In Affil Ops", ["filed-ubuntu", "filed-repo"]],
      ["In machine", ["repo-chat"]],
      ["Other chats", ["repo-chat-2"]],
    ]);
  });

  it("puts lineage first and does not repeat it in later sections", () => {
    const parent = thread(mac, "parent", "repo", "2026-09-25T14:00:00Z");
    const fork = thread(mac, "fork", "repo", "2026-09-25T13:00:00Z");
    const filed = thread(mac, "filed", "repo", "2026-09-25T12:00:00Z");
    const sections = sectionDockChatCandidates({
      threads: [parent, fork, filed],
      hostThreadRef,
      hostProjectId: "repo",
      repoTitle: "machine",
      workProject: { name: "Work", threadKeys: new Set([keyOf(fork), keyOf(filed)]) },
      lineageThreadKeys: new Set([keyOf(parent), keyOf(fork)]),
    });

    expect(sections.map((section) => [section.title, section.threads.map((t) => t.id)])).toEqual([
      ["Lineage", ["parent", "fork"]],
      ["In Work", ["filed"]],
    ]);
  });

  it("includes an archived lineage chat but not unrelated archived chats", () => {
    const archivedLineage = thread(
      mac,
      "archived-lineage",
      "repo",
      "2026-09-25T12:00:00Z",
      "2026-09-25T12:30:00Z",
    );
    const archivedOther = thread(
      mac,
      "archived-other",
      "repo",
      "2026-09-25T11:00:00Z",
      "2026-09-25T11:30:00Z",
    );
    const sections = sectionDockChatCandidates({
      threads: [archivedLineage, archivedOther],
      hostThreadRef,
      hostProjectId: "repo",
      repoTitle: "machine",
      workProject: null,
      lineageThreadKeys: new Set([keyOf(archivedLineage)]),
    });

    expect(sections.map((section) => section.id)).toEqual(["lineage"]);
    expect(sections[0]?.threads.map((entry) => entry.id)).toEqual(["archived-lineage"]);
  });

  it("drops empty sections and caps other chats", () => {
    const others = Array.from({ length: DOCK_OTHER_CHATS_LIMIT + 5 }, (_, index) =>
      thread(
        ubuntu,
        `other-${index}`,
        "elsewhere",
        `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      ),
    );
    const sections = sectionDockChatCandidates({
      threads: others,
      hostThreadRef,
      hostProjectId: "repo",
      repoTitle: "machine",
      workProject: null,
    });
    expect(sections.map((section) => section.id)).toEqual(["other"]);
    expect(sections[0]?.threads).toHaveLength(DOCK_OTHER_CHATS_LIMIT);
  });
});
