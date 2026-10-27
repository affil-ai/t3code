import {
  type AgentProfile,
  AgentProfileId,
  type AgentsSnapshot,
  EnvironmentId,
  FIRSTMATE_AGENT_ID,
  type FirstmateSnapshot,
  type FirstmateTask,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createAgentsHomeAtoms } from "./agents.ts";

const environmentId = EnvironmentId.make("env-1");
const scoutId = AgentProfileId.make("scout");

const agents = [
  { id: FIRSTMATE_AGENT_ID, coordinatorThreadId: ThreadId.make("fm-chat"), homeProjectId: null },
  { id: scoutId, coordinatorThreadId: ThreadId.make("scout-chat"), homeProjectId: null },
] as unknown as ReadonlyArray<AgentProfile>;

function board(workerThreadId: string, title: string): FirstmateSnapshot {
  return {
    tasks: [{ id: `task-${workerThreadId}`, title, workerThreadId: ThreadId.make(workerThreadId) }],
  } as unknown as FirstmateSnapshot;
}

function setup() {
  const presentations = Atom.make(
    new Map([[environmentId, { connection: { phase: "connected" } }]]) as ReadonlyMap<
      EnvironmentId,
      { readonly connection: { readonly phase: string } }
    >,
  );
  const live = Atom.make(
    AsyncResult.success({ agents } as unknown as AgentsSnapshot) as AsyncResult.AsyncResult<
      AgentsSnapshot,
      unknown
    >,
  );
  const boards = {
    [FIRSTMATE_AGENT_ID]: Atom.make(
      AsyncResult.success(board("fm-worker", "a")) as AsyncResult.AsyncResult<
        FirstmateSnapshot,
        unknown
      >,
    ),
    [scoutId]: Atom.make(
      AsyncResult.success(board("scout-worker", "b")) as AsyncResult.AsyncResult<
        FirstmateSnapshot,
        unknown
      >,
    ),
  } as Record<string, Atom.Writable<AsyncResult.AsyncResult<FirstmateSnapshot, unknown>>>;
  const atoms = createAgentsHomeAtoms({
    presentationsAtom: presentations,
    live: () => live,
    tasks: (target) => boards[target.input.agentId]!,
  });
  return { registry: AtomRegistry.make(), presentations, boards, atoms };
}

describe("createAgentsHomeAtoms", () => {
  it("keeps every lookup's identity when only presentations change", () => {
    const { registry, presentations, atoms } = setup();
    const unmount = [
      registry.mount(atoms.homeAtom),
      registry.mount(atoms.coordinatorThreadKeysAtom),
      registry.mount(atoms.customAgentWorkerThreadKeysAtom),
      registry.mount(atoms.agentByThreadKeyAtom),
    ];
    const before = [
      registry.get(atoms.homeAtom),
      registry.get(atoms.coordinatorThreadKeysAtom),
      registry.get(atoms.customAgentWorkerThreadKeysAtom),
      registry.get(atoms.agentByThreadKeyAtom),
    ];
    registry.set(presentations, new Map([[environmentId, { connection: { phase: "connected" } }]]));
    expect([
      registry.get(atoms.homeAtom),
      registry.get(atoms.coordinatorThreadKeysAtom),
      registry.get(atoms.customAgentWorkerThreadKeysAtom),
      registry.get(atoms.agentByThreadKeyAtom),
    ]).toEqual(before);
    expect(registry.get(atoms.homeAtom)).toBe(before[0]);
    expect(registry.get(atoms.agentByThreadKeyAtom)).toBe(before[3]);
    for (const stop of unmount) stop();
  });

  it("keeps the key sets when a board update changes no worker chat", () => {
    const { registry, boards, atoms } = setup();
    const stop = registry.mount(atoms.customAgentWorkerThreadKeysAtom);
    const stopTasks = registry.mount(atoms.taskByWorkerThreadKeyAtom);
    const keys = registry.get(atoms.customAgentWorkerThreadKeysAtom);
    const tasks = registry.get(atoms.taskByWorkerThreadKeyAtom);
    registry.set(boards[scoutId]!, AsyncResult.success(board("scout-worker", "renamed")));
    expect(registry.get(atoms.customAgentWorkerThreadKeysAtom)).toBe(keys);
    // The task itself changed, so the task lookup moves on.
    const next = registry.get(atoms.taskByWorkerThreadKeyAtom);
    expect(next).not.toBe(tasks);
    expect([...next.values()].map((task: FirstmateTask) => task.title).sort()).toEqual([
      "a",
      "renamed",
    ]);
    stop();
    stopTasks();
  });
});
