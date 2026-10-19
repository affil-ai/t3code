import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sectionDockChatCandidates } from "./DockChatPanel.logic";

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
  it("lists only the host's repo chats, most recent first, without the host or archived chats", () => {
    const older = thread(mac, "older", "repo", "2026-09-25T09:00:00Z");
    const newer = thread(mac, "newer", "repo", "2026-09-25T11:00:00Z");
    const otherRepo = thread(mac, "other-repo", "elsewhere", "2026-09-25T12:00:00Z");
    const sameProjectIdOtherMachine = thread(ubuntu, "ubuntu-repo", "repo", "2026-09-25T13:00:00Z");
    const archived = thread(
      mac,
      "archived",
      "repo",
      "2026-09-25T12:00:00Z",
      "2026-09-25T12:30:00Z",
    );
    const host = thread(mac, "host", "repo", "2026-09-25T14:00:00Z");

    const sections = sectionDockChatCandidates({
      threads: [older, newer, otherRepo, sameProjectIdOtherMachine, archived, host],
      hostThreadRef,
      hostProjectId: "repo",
      repoTitle: "machine",
    });

    expect(sections.map((section) => [section.title, section.threads.map((t) => t.id)])).toEqual([
      ["In machine", ["newer", "older"]],
    ]);
  });

  it("puts lineage first, from any project, and does not repeat it in the repo section", () => {
    const parent = thread(mac, "parent", "elsewhere", "2026-09-25T14:00:00Z");
    const fork = thread(mac, "fork", "repo", "2026-09-25T13:00:00Z");
    const repoChat = thread(mac, "repo-chat", "repo", "2026-09-25T12:00:00Z");
    const sections = sectionDockChatCandidates({
      threads: [parent, fork, repoChat],
      hostThreadRef,
      hostProjectId: "repo",
      repoTitle: "machine",
      lineageThreadKeys: new Set([keyOf(parent), keyOf(fork)]),
    });

    expect(sections.map((section) => [section.title, section.threads.map((t) => t.id)])).toEqual([
      ["Lineage", ["parent", "fork"]],
      ["In machine", ["repo-chat"]],
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
      lineageThreadKeys: new Set([keyOf(archivedLineage)]),
    });

    expect(sections.map((section) => section.id)).toEqual(["lineage"]);
    expect(sections[0]?.threads.map((entry) => entry.id)).toEqual(["archived-lineage"]);
  });

  it("returns no sections when nothing is related", () => {
    const sections = sectionDockChatCandidates({
      threads: [thread(ubuntu, "elsewhere-chat", "elsewhere", "2026-09-25T00:00:00Z")],
      hostThreadRef,
      hostProjectId: "repo",
      repoTitle: "machine",
    });
    expect(sections).toEqual([]);
  });
});
