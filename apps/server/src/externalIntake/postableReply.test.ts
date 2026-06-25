import { describe, expect, it } from "vite-plus/test";

import {
  flattenMarkdownTablesForSlack,
  postablePullRequestMerged,
  postableReplyBody,
  postableSupportEmailNotification,
  postableTaskStartedStatus,
  postableUserInputRequest,
  postableUserInputResponseFailed,
  protectSlackPackageScopes,
} from "./postableReply.ts";

describe("postableReplyBody", () => {
  it("posts Slack replies as Markdown so the Slack adapter converts formatting", () => {
    expect(
      postableReplyBody({
        kind: "slack_thread",
        body: "**Dependencies**\n\n- `react`\n- `vite`",
      }),
    ).toEqual({
      markdown: "**Dependencies**\n\n- `react`\n- `vite`",
    });
  });

  it("flattens Markdown tables before Slack can drop cell formatting", () => {
    expect(
      flattenMarkdownTablesForSlack(
        [
          "| Package | Purpose |",
          "| --- | --- |",
          "| **apps/web** | `next`, **React** |",
          "| **packages/db** | Database helpers |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "- **apps/web:** **Purpose:** `next`, **React**",
        "- **packages/db:** **Purpose:** Database helpers",
      ].join("\n"),
    );
  });

  it("protects scoped package names from Slack mention expansion", () => {
    expect(
      protectSlackPackageScopes("Uses @sentry/nextjs, @vercel/*, and `@repo/ui` packages."),
    ).toBe("Uses `@sentry/nextjs`, `@vercel/*`, and `@repo/ui` packages.");
  });
});

describe("postableTaskStartedStatus", () => {
  it("builds a Slack task started card with an Open T3 button", () => {
    const message = postableTaskStartedStatus({
      kind: "slack_thread",
      t3ThreadUrl: "https://t3.example.com/environment-local/thread-123",
    });

    expect(message).toMatchObject({
      fallbackText: expect.stringContaining("Open T3"),
      card: {
        title: "Talk to Vevin in this thread",
      },
    });
    expect(JSON.stringify(message)).toContain(
      "https://t3.example.com/environment-local/thread-123",
    );
  });
});

describe("postableUserInputRequest", () => {
  it("formats Claude questions for Slack replies", () => {
    expect(
      postableUserInputRequest({
        kind: "slack_thread",
        questions: [
          {
            id: "Which framework?",
            header: "Framework",
            question: "Which framework?",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      }),
    ).toEqual({
      markdown: [
        "Claude needs input to continue.",
        "",
        "**Q1: Framework**",
        "Which framework?",
        "",
        "Options:",
        "- 1: **React** - React.js",
        "- 2: **Vue** - Vue.js",
        "",
        "Reply in this thread with the answer.",
      ].join("\n"),
    });
  });

  it("tells users that one reply can answer every question", () => {
    const message = postableUserInputRequest({
      kind: "slack_thread",
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which scope?",
          options: [{ label: "All", description: "Apply everywhere" }],
          multiSelect: false,
        },
        {
          id: "mode",
          header: "Mode",
          question: "Which mode?",
          options: [{ label: "Fast", description: "Move quickly" }],
          multiSelect: false,
        },
      ],
    });

    expect(message).toMatchObject({
      markdown: expect.stringContaining(
        "Reply with one answer to apply it to every question, or answer each question with `Q1: ...`, `Q2: ...`.",
      ),
    });
  });
});

describe("postableUserInputResponseFailed", () => {
  it("formats provider response failures for Slack", () => {
    expect(
      postableUserInputResponseFailed({
        kind: "slack_thread",
        detail: "Stale pending user-input request: req-1.",
      }),
    ).toEqual({
      markdown: [
        "I couldn't submit that response to Claude.",
        "",
        "Reason: Stale pending user-input request: req-1.",
        "",
        "Open T3 and restart the turn if Claude's pending question is stale.",
      ].join("\n"),
    });
  });
});

describe("postableSupportEmailNotification", () => {
  it("builds a support email card with an Open T3 button", () => {
    const message = postableSupportEmailNotification({
      kind: "slack_thread",
      title: "New support email from user@example.com: Retry failed",
      preview: "From: user@example.com\n\nThe retry button still fails.",
      t3ThreadUrl: "https://t3.example.com/environment-local/thread-123",
    });

    expect(message).toMatchObject({
      fallbackText: expect.stringContaining("Open T3"),
      card: {
        title: "New support email from user@example.com: Retry failed",
      },
    });
    expect(JSON.stringify(message)).toContain("Open T3");
    expect(JSON.stringify(message)).toContain(
      "https://t3.example.com/environment-local/thread-123",
    );
  });
});

describe("postablePullRequestMerged", () => {
  it("builds a Slack PR merged reply with the PR number and title linked", () => {
    const message = postablePullRequestMerged({
      kind: "slack_thread",
      pullRequestUrl: "https://github.com/acme/app/pull/42",
      title: "Add checkout filter",
    });

    expect(message).toEqual({
      markdown:
        "Merged noted. [PR #42: Add checkout filter](https://github.com/acme/app/pull/42) is done.",
    });
    expect(JSON.stringify(message)).not.toContain("New PR");
  });

  it("escapes markdown delimiters in the linked PR title", () => {
    const message = postablePullRequestMerged({
      kind: "slack_thread",
      pullRequestUrl: "https://github.com/acme/app/pull/43",
      title: "Handle [beta] rollout",
    });

    expect(message).toEqual({
      markdown:
        "Merged noted. [PR #43: Handle \\[beta\\] rollout](https://github.com/acme/app/pull/43) is done.",
    });
  });
});
