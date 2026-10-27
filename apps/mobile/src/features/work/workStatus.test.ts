import { FIRSTMATE_COLUMN_IDS } from "@t3tools/client-runtime/firstmate/board";
import { describe, expect, it } from "vite-plus/test";

import { COLUMN_DOT_CLASS, workerStatusPresentation } from "./workStatus";

describe("work status presentation", () => {
  it("colors every board section", () => {
    for (const column of FIRSTMATE_COLUMN_IDS) expect(COLUMN_DOT_CLASS[column]).toMatch(/^bg-/);
  });

  it("shows an idle worker only once it has finished unseen", () => {
    expect(workerStatusPresentation("ready", false)).toBeNull();
    expect(workerStatusPresentation("ready", true)?.label).toBe("Finished");
    expect(workerStatusPresentation("input", false)?.label).toBe("Awaiting input");
  });
});
