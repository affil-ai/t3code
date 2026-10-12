import { describe, expect, it } from "vite-plus/test";

import { formatNotificationSnippet, lastAssistantText } from "./notificationSnippet.logic";

describe("formatNotificationSnippet", () => {
  it("reduces markdown to one readable line", () => {
    expect(
      formatNotificationSnippet(
        "## Done\n\nThe **web build** is live on [t3.olumbe.com](https://t3.olumbe.com).\n\n- Ran `tests`\n- Pushed",
      ),
    ).toBe("Done The web build is live on t3.olumbe.com. Ran tests Pushed");
  });

  it("drops code blocks and hidden markers", () => {
    expect(
      formatNotificationSnippet(
        "<!-- t3work-parent: abc -->Fixed it.\n```sh\nrm -rf x\n```\nDone.",
      ),
    ).toBe("Fixed it. Done.");
  });

  it("cuts long replies at a word boundary with an ellipsis", () => {
    const snippet = formatNotificationSnippet("word ".repeat(100), 40);
    expect(snippet?.endsWith("…")).toBe(true);
    expect(snippet!.length).toBeLessThanOrEqual(40);
    expect(snippet).not.toMatch(/\s…$/);
  });

  it("returns null when nothing readable is left", () => {
    expect(formatNotificationSnippet("```\ncode only\n```")).toBeNull();
    expect(formatNotificationSnippet("   ")).toBeNull();
  });
});

describe("lastAssistantText", () => {
  it("returns the latest non-empty assistant message", () => {
    expect(
      lastAssistantText([
        { role: "user", text: "do it" },
        { role: "assistant", text: "first" },
        { role: "assistant", text: "final" },
        { role: "assistant", text: "  " },
        { role: "system", text: "note" },
      ]),
    ).toBe("final");
  });

  it("returns null without an assistant reply", () => {
    expect(lastAssistantText([{ role: "user", text: "hi" }])).toBeNull();
  });
});
