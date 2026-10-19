// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AgentAvatarUpload } from "./AgentAvatarUpload";

const mocks = vi.hoisted(() => ({
  cycle: vi.fn(),
  remove: vi.fn(),
  change: vi.fn(),
  pending: vi.fn(),
  canUpload: true,
}));
vi.mock("@t3tools/client-runtime/state/attachments", () => ({
  runAttachmentUploadCycle: (...args: unknown[]) => mocks.cycle(...args),
  deletePendingAttachmentUpload: (...args: unknown[]) => mocks.remove(...args),
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: {}, remove: {} },
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: () => mocks.canUpload,
  readPreparedConnection: () => ({ httpBaseUrl: "https://remote.example/base" }),
}));

let container: HTMLDivElement;
let root: Root;
const environmentId = EnvironmentId.make("remote");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.canUpload = true;
  mocks.cycle.mockReset();
  mocks.remove.mockClear();
  mocks.change.mockClear();
  mocks.pending.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(value: string | null = null) {
  await act(() =>
    root.render(
      <AgentAvatarUpload
        environmentId={environmentId}
        value={value}
        disabled={false}
        onChange={mocks.change}
        onPendingChange={mocks.pending}
      />,
    ),
  );
}
async function choose(file: File) {
  const input = container.querySelector("input")!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}
const png = () => new File(["pixels"], "avatar.png", { type: "image/png" });

describe("avatar upload controls", () => {
  it("rejects unsupported or empty files without uploading or replacing the current avatar", async () => {
    await render("existing");
    await choose(new File(["<svg/>"], "avatar.svg", { type: "image/svg+xml" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("PNG, JPEG");
    await choose(new File([], "empty.png", { type: "image/png" }));
    expect(mocks.cycle).not.toHaveBeenCalled();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("replaces an avatar after upload, supports removal, and releases only form-owned uploads", async () => {
    mocks.cycle.mockImplementation(async (input) => {
      expect(input.onMinted("pending-upload")).toBe("continue");
      return { status: "uploaded", attachmentId: "pending-upload" };
    });
    await render("existing");
    await choose(png());
    expect(mocks.change).toHaveBeenCalledWith("pending-upload");
    expect(mocks.pending.mock.calls).toEqual([[true], [false]]);
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Remove image")!
        .click(),
    );
    expect(mocks.change).toHaveBeenLastCalledWith(null);
    await act(() => root.render(null));
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, attachmentId: "pending-upload" }),
    );
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it("keeps the old avatar after an upload failure and allows retry", async () => {
    mocks.cycle.mockResolvedValue({ status: "failed", attachmentId: null });
    await render("existing");
    await choose(png());
    expect(mocks.change).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Try again");
    mocks.cycle.mockResolvedValue({ status: "uploaded", attachmentId: "retry" });
    await choose(png());
    expect(mocks.change).toHaveBeenCalledWith("retry");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("cancels a late mint when the dialog has closed", async () => {
    let finish!: () => void;
    mocks.cycle.mockImplementation(
      (input) =>
        new Promise((resolve) => {
          finish = () => {
            expect(input.onMinted("late")).toBe("cancel");
            resolve({ status: "cancelled", attachmentId: "late" });
          };
        }),
    );
    await render();
    await choose(png());
    await act(() => root.render(null));
    await act(() => finish());
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("does not permit uploads without the environment's write grant", async () => {
    mocks.canUpload = false;
    await render();
    expect(container.querySelector("button")?.disabled).toBe(true);
    await choose(png());
    expect(mocks.cycle).not.toHaveBeenCalled();
  });
});
