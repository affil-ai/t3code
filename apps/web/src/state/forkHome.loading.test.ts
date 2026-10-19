import { EnvironmentId, FIRSTMATE_WS_METHODS } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const fixture = await vi.hoisted(async () => {
  const { Atom, AtomRegistry } = await import("effect/reactivity");
  return {
    registry: AtomRegistry.make(),
    presentations: Atom.make(
      new Map<
        string,
        {
          connection: { phase: string };
          serverConfig: object | null;
        }
      >(),
    ),
    subscribe: vi.fn(),
  };
});
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: fixture.registry }));
vi.mock("./presentation", () => ({
  environmentPresentations: { presentationsAtom: fixture.presentations },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createAtomCommandScheduler: () => ({}),
  createEnvironmentRpcCommand: () => ({}),
  createEnvironmentRpcQueryAtomFamily: () => ({}),
  createEnvironmentRpcSubscriptionAtomFamily:
    (_runtime: unknown, options: { tag: string }) => (target: { environmentId: string }) =>
      fixture.subscribe(options.tag, target.environmentId),
}));

import { readAgentsHome } from "./agents";
import { readFirstmateHome } from "./firstmate";

const remote = EnvironmentId.make("remote");
describe.each([
  ["agents", readAgentsHome, FIRSTMATE_WS_METHODS.agentsSubscribe, { agents: [] }],
  ["Firstmate", readFirstmateHome, FIRSTMATE_WS_METHODS.firstmateSubscribe, { tasks: [] }],
] as const)("%s sidebar startup", (_name, read, tag, value) => {
  it("starts before unrelated server config arrives", () => {
    fixture.subscribe.mockReset();
    fixture.subscribe.mockReturnValue(Atom.make(AsyncResult.success(value)));
    fixture.registry.set(
      fixture.presentations,
      new Map([[remote, { connection: { phase: "connected" }, serverConfig: null }]]),
    );
    expect(read()?.environmentId).toBe(remote);
    expect(fixture.subscribe).toHaveBeenCalledWith(tag, remote);
  });

  it("primes connected hosts in parallel without changing home priority", () => {
    const local = EnvironmentId.make("local");
    fixture.subscribe.mockReset();
    fixture.subscribe.mockImplementation((_tag: string, id: string) =>
      id === remote ? pending : ready,
    );
    const pending = Atom.make(AsyncResult.initial(false));
    const ready = Atom.make(AsyncResult.success(value));
    fixture.registry.set(
      fixture.presentations,
      new Map([
        [remote, { connection: { phase: "connected" }, serverConfig: {} }],
        [local, { connection: { phase: "connected" }, serverConfig: {} }],
      ]),
    );
    expect(read()).toBeNull();
    expect(fixture.subscribe).toHaveBeenCalledWith(tag, remote);
    expect(fixture.subscribe).toHaveBeenCalledWith(tag, local);
  });
});
