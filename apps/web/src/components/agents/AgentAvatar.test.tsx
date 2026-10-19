// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AgentAvatar } from "./AgentAvatar";

const mocks = vi.hoisted(() => ({
  asset: { _tag: "Success", url: "https://remote.example/api/assets/signed/avatar.png" },
  useAssetUrlState: vi.fn(),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: (...args: unknown[]) => {
    mocks.useAssetUrlState(...args);
    return mocks.asset;
  },
}));

let container: HTMLDivElement;
let root: Root;
const environmentId = EnvironmentId.make("remote");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.asset = { _tag: "Success", url: "https://remote.example/api/assets/signed/avatar.png" };
  mocks.useAssetUrlState.mockClear();
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("agent avatars", () => {
  it("keeps icon/color agents independent of image access", async () => {
    await act(() => root.render(<AgentAvatar icon="dollar-sign" color="green" />));
    expect(container.querySelector(".lucide-dollar-sign")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(mocks.useAssetUrlState).not.toHaveBeenCalled();
  });

  it("uses the owning environment's signed asset and recovers from a broken image on replacement", async () => {
    const render = (attachmentId: string) =>
      act(() =>
        root.render(
          <AgentAvatar
            icon="dollar-sign"
            color="green"
            environmentId={environmentId}
            avatarAttachmentId={attachmentId}
          />,
        ),
      );
    await render("avatar-1");
    expect(mocks.useAssetUrlState).toHaveBeenLastCalledWith(environmentId, {
      _tag: "attachment",
      attachmentId: "avatar-1",
    });
    expect(container.querySelector("img")?.src).toBe(mocks.asset.url);
    await act(() => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-dollar-sign")).not.toBeNull();
    mocks.asset = {
      _tag: "Success",
      url: "https://remote.example/api/assets/signed/replacement.png",
    };
    await render("avatar-2");
    expect(container.querySelector("img")?.src).toBe(mocks.asset.url);
    await act(() =>
      root.render(<AgentAvatar icon="dollar-sign" color="green" environmentId={environmentId} />),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".lucide-dollar-sign")).not.toBeNull();
  });
});
