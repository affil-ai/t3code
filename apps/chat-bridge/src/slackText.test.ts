import { assert, it } from "vite-plus/test";

import { withoutAttribution, withRichContent } from "./slackText.ts";

it("leaves a plain message alone", () => {
  assert.strictEqual(withRichContent("fix the build", { text: "fix the build" }), "fix the build");
  assert.strictEqual(withRichContent("hi", undefined), "hi");
});

it("adds an app's block and attachment text under its summary", () => {
  const raw = {
    text: "Deploy failed",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "*Deploy failed* on `web`" } },
      { type: "section", fields: [{ type: "mrkdwn", text: "Commit: abc123" }] },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open logs" },
            url: "https://ci.example/run/9",
          },
        ],
      },
    ],
    attachments: [
      {
        fallback: "Error: missing env FOO",
        fields: [{ title: "Region", value: "iad1" }],
      },
    ],
  };
  const text = withRichContent("Deploy failed", raw);
  assert.include(text, "Deploy failed on web");
  assert.include(text, "Commit: abc123");
  assert.include(text, "Error: missing env FOO");
  assert.include(text, "Region");
  assert.include(text, "iad1");
  assert.include(text, "Open logs: https://ci.example/run/9");
  // Repeats of what the reader already has are left out.
  assert.strictEqual(text.match(/Deploy failed/g)?.length, 2);
});

it("shows the URL behind a labelled link and a shared document", () => {
  const raw = {
    text: "see <https://example.com/a?x=1&amp;y=2|the spec>",
    blocks: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [
              { type: "link", url: "https://example.com/a?x=1&y=2", text: "the spec" },
              { type: "attachment_mention", url: "https://docs.google.com/d/1", text: "Plan" },
            ],
          },
        ],
      },
    ],
  };
  const text = withRichContent("see the spec", raw);
  assert.include(text, "the spec: https://example.com/a?x=1&y=2");
  assert.include(text, "Plan: https://docs.google.com/d/1");
  assert.strictEqual(text.match(/example\.com/g)?.length, 1);
});

it("drops the footer an app adds when it posts for someone", () => {
  assert.strictEqual(
    withoutAttribution("what codeword? *Sent using* <@U0BC8FXNJG0>"),
    "what codeword?",
  );
  assert.strictEqual(
    withoutAttribution("aside: heron Sent using @ChatGPT\nSent using @U0BC8FXNJG0"),
    "aside: heron",
  );
  assert.strictEqual(withoutAttribution("ask <@U0GRACE> about it"), "ask <@U0GRACE> about it");
});
