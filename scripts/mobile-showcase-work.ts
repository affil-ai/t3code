// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This host-side fixture seeds an isolated local T3 environment.
/**
 * The Work fixture for the mobile screenshot harness: agents, their task
 * boards, a coordinator chat, and its automations. It writes the rows the
 * fork's agent core reads (`apps/server/src/firstmate/store.ts`) and the
 * scheduled-task rows, inside the environment seed's transaction.
 *
 * The data keeps the agent core quiet while the app is captured: every open
 * task is already marked as orphan-notified, none has a wake time, workers are
 * settled threads, and automations next run hours away. So the reactor never
 * sends the coordinator a wake and no provider turn starts.
 *
 * @module mobile-showcase-work
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as NodeSqlite from "node:sqlite";
import { PNG } from "pngjs";

/** The seeded task the work-task scene opens. The app's copy is `SHOWCASE_WORK_TASK_ID`. */
export const SHOWCASE_WORK_TASK_ID = "fm-cold-start";
export const SHOWCASE_COORDINATOR_THREAD_ID = "firstmate-coordinator";

const FIRSTMATE_AGENT_ID = "firstmate";
const MODEL_SELECTION = JSON.stringify({ instanceId: "codex", model: "gpt-5.4" });

/** Tables the fork's services create at startup; the seed waits for them. */
export const SHOWCASE_WORK_TABLES = [
  "firstmate_agent",
  "firstmate_task",
  "firstmate_task_event",
  "firstmate_config",
  "scheduled_tasks",
] as const;

/**
 * Settled threads in each project that the Firstmate tasks name as their
 * workers, first to the detail task. Waiting or running threads are left out
 * so the reactor has nothing to report.
 */
export const SHOWCASE_WORK_WORKER_THREADS: Readonly<Record<string, ReadonlyArray<string>>> = {
  t3code: ["handoff-haptics"],
  react: ["streaming-shell", "hydration-haikus"],
  linux: ["quieter-oom", "patient-penguins"],
};

/**
 * Firstmate's coordinator chat. It is old and settled so that, in an
 * environment the app does not use as its Firstmate home (where the thread
 * list does not hide it), it sits below the hero threads.
 */
export const SHOWCASE_COORDINATOR_THREAD = {
  id: SHOWCASE_COORDINATOR_THREAD_ID,
  title: "Firstmate",
  branch: "main",
  minutesAgo: 3 * 24 * 60,
  settled: true,
  request: "Morning! What needs me today?",
  response:
    "Two things need you:\n\n- **Cold start** — round 7 is at 1.21 s, down from 1.84 s. Approve keeping it and the worker starts round 8.\n- **Offline outbox** — PR #482 is green and reviewed, ready for your merge.\n\nThe 2.4 build is with App Review, and sync errors have stayed flat since the 2.3 rollout.",
} as const;

/** Where the agent core keeps its shared folder for one disposable environment. */
export function showcaseAgentsHome(baseDir: string) {
  const root = NodePath.join(baseDir, "agents");
  return {
    root,
    legacyRoot: NodePath.join(baseDir, "firstmate"),
    artifactsRoot: NodePath.join(root, "artifacts"),
  };
}

/**
 * Points the agent core's folders into the environment. Without these the
 * server would use, and migrate, `~/agents` and `~/firstmate` on the host.
 */
export function showcaseAgentsHomeEnv(baseDir: string): Record<string, string> {
  const home = showcaseAgentsHome(baseDir);
  return { T3CODE_AGENTS_HOME: home.root, T3CODE_FIRSTMATE_HOME: home.legacyRoot };
}

type TaskStatus =
  | "backlog"
  | "planning"
  | "in_progress"
  | "in_review"
  | "ready_for_deployment"
  | "monitoring"
  | "hillclimb"
  | "done"
  | "canceled";
type NextActor = "coordinator" | "worker" | "user" | "external";

/** Mirrors `firstmateStateForStatus` in packages/contracts/src/firstmate.ts. */
function stateForStatus(status: TaskStatus): string {
  switch (status) {
    case "done":
      return "done";
    case "canceled":
      return "dropped";
    case "in_review":
      return "waiting";
    case "ready_for_deployment":
      return "ready";
    default:
      return "open";
  }
}

interface ShowcaseAgent {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly icon: string;
  readonly color: string;
  readonly role: string;
  readonly createdDaysAgo: number;
}

/** Five agents beside Firstmate, so the switcher shows its compact grid (more than four). */
const SHOWCASE_AGENTS: ReadonlyArray<ShowcaseAgent> = [
  {
    id: "agent-growth-lead",
    slug: "growth-lead",
    name: "Growth Lead",
    icon: "rocket",
    color: "emerald",
    role: "Owns launch posts, changelog copy, and onboarding experiments.",
    createdDaysAgo: 30,
  },
  {
    id: "agent-design-review",
    slug: "design-review",
    name: "Design Review",
    icon: "palette",
    color: "pink",
    role: "Reviews every UI change against the design system before it ships.",
    createdDaysAgo: 24,
  },
  {
    id: "agent-release-captain",
    slug: "release-captain",
    name: "Release Captain",
    icon: "ship-wheel",
    color: "amber",
    role: "Cuts releases, writes the notes, and watches the rollout.",
    createdDaysAgo: 18,
  },
  {
    id: "agent-research",
    slug: "research",
    name: "Research",
    icon: "search",
    color: "violet",
    role: "Answers technical questions with sources and a short recommendation.",
    createdDaysAgo: 12,
  },
  {
    id: "agent-support-triage",
    slug: "support-triage",
    name: "Support Triage",
    icon: "shield-check",
    color: "teal",
    role: "Sorts incoming reports, reproduces bugs, and files them on the board.",
    createdDaysAgo: 6,
  },
];

interface ShowcaseTaskProgress {
  readonly label: string;
  readonly kind: "metric" | "count";
  readonly unit?: string;
  readonly direction?: "higher" | "lower";
  readonly baseline?: number;
  readonly target?: number;
  /** Oldest first; the last value is the current one. */
  readonly history: ReadonlyArray<number>;
}

interface ShowcaseTask {
  readonly id: string;
  readonly agentId: string;
  readonly title: string;
  readonly intent: string;
  readonly definitionOfDone: string;
  readonly status: TaskStatus;
  readonly nextActor: NextActor;
  readonly nextStep: string | null;
  readonly note: string;
  readonly priority?: boolean;
  /** Index into the project's worker threads. */
  readonly worker?: number;
  readonly createdMinutesAgo: number;
  readonly minutesAgo: number;
  readonly links?: ReadonlyArray<{ readonly label: string; readonly url: string }>;
  readonly artifacts?: ReadonlyArray<{
    readonly kind: "link" | "image";
    readonly label: string;
    /** For an image, a file name under the task's artifacts folder. */
    readonly url: string;
    readonly caption?: string;
  }>;
  readonly progress?: ShowcaseTaskProgress;
  readonly closeEvidence?: string;
  readonly events?: ReadonlyArray<{
    readonly minutesAgo: number;
    readonly actor: "coordinator" | "user" | "system";
    readonly summary: string;
  }>;
}

const REPOSITORY = "https://github.com/lumen-labs/lumen";
const STARTUP_TRACE_FILE = "startup-trace.png";
const DAY = 24 * 60;

const SHOWCASE_TASKS: ReadonlyArray<ShowcaseTask> = [
  {
    id: SHOWCASE_WORK_TASK_ID,
    agentId: FIRSTMATE_AGENT_ID,
    title: "Cut mobile cold start under one second",
    intent:
      "Startup feels slow on older phones. Get cold start under a second without dropping features.",
    definitionOfDone:
      "- Median cold start under 1,000 ms on the reference phone\n- No regression in the first thread render\n- A trace for each kept round",
    status: "hillclimb",
    nextActor: "user",
    nextStep: "Approve keeping round 7",
    note: "Round 7 defers the syntax highlighter until a code block first renders. Rounds 3 and 5 were reverted: they slowed the first thread render.",
    priority: true,
    worker: 0,
    createdMinutesAgo: 2 * DAY,
    minutesAgo: 6,
    links: [
      { label: "PR #512", url: `${REPOSITORY}/pull/512` },
      { label: "Benchmark dashboard", url: "https://bench.lumen.test/cold-start" },
    ],
    artifacts: [
      {
        kind: "image",
        label: "Startup trace, round 7",
        url: STARTUP_TRACE_FILE,
        caption: "The highlighter no longer blocks the first frame.",
      },
      {
        kind: "link",
        label: "Round 7 benchmark",
        url: "https://bench.lumen.test/cold-start/runs/7",
        caption: "Median of 30 launches on the reference phone.",
      },
    ],
    progress: {
      label: "Cold start",
      kind: "metric",
      unit: "ms",
      direction: "lower",
      baseline: 1840,
      target: 1000,
      history: [1840, 1796, 1702, 1731, 1588, 1612, 1414, 1338, 1210],
    },
    events: [
      { minutesAgo: 2 * DAY, actor: "user", summary: "Asked for cold start under one second." },
      {
        minutesAgo: 2 * DAY - 10,
        actor: "coordinator",
        summary: "Froze the benchmark: 30 launches on the reference phone, median reported.",
      },
      {
        minutesAgo: 2 * DAY - 40,
        actor: "system",
        summary: "Worker measured the baseline: 1,840 ms.",
      },
      {
        minutesAgo: DAY,
        actor: "coordinator",
        summary: "Reverted round 5: it slowed the first thread render by 90 ms.",
      },
      {
        minutesAgo: 6,
        actor: "coordinator",
        summary: "Round 7 reached 1,210 ms with no render regression. Asked to keep it.",
      },
    ],
  },
  {
    id: "fm-offline-outbox",
    agentId: FIRSTMATE_AGENT_ID,
    title: "Queue messages while offline",
    intent: "Let people send from the train. Messages should wait and send when the phone is back.",
    definitionOfDone:
      "- Messages sent offline show as pending\n- They send in order on reconnect\n- Editing a pending message works",
    status: "in_review",
    nextActor: "user",
    nextStep: "Approve merge of #482",
    note: "Reviewed by Design Review. All checks green.",
    worker: 1,
    createdMinutesAgo: 3 * DAY,
    minutesAgo: 18,
    links: [{ label: "PR #482", url: `${REPOSITORY}/pull/482` }],
  },
  {
    id: "fm-release-2-4",
    agentId: FIRSTMATE_AGENT_ID,
    title: "Ship 2.4 to the App Store",
    intent: "Release 2.4 with the new composer and the offline outbox.",
    definitionOfDone: "- Build approved by App Review\n- Phased release started",
    status: "ready_for_deployment",
    nextActor: "external",
    nextStep: "Waiting on App Review",
    note: "Submitted build 2.4.0 (412).",
    createdMinutesAgo: 4 * DAY,
    minutesAgo: 50,
    links: [{ label: "Release checklist", url: `${REPOSITORY}/issues/470` }],
  },
  {
    id: "fm-sync-errors",
    agentId: FIRSTMATE_AGENT_ID,
    title: "Watch sync errors after the 2.3 rollout",
    intent: "Make sure the new sync engine holds up at 100% rollout.",
    definitionOfDone: "- Error rate stays under 0.1% for 72 hours",
    status: "monitoring",
    nextActor: "coordinator",
    nextStep: "Check the error rate tomorrow morning",
    note: "Flat at 0.04% for 41 hours.",
    createdMinutesAgo: 5 * DAY,
    minutesAgo: 3 * 60,
  },
  {
    id: "fm-push-digest",
    agentId: FIRSTMATE_AGENT_ID,
    title: "Bundle quiet notifications into a digest",
    intent: "Low-priority notifications should arrive as one summary instead of a stream.",
    definitionOfDone: "- Digest setting with a delivery time\n- Urgent notifications still arrive",
    status: "planning",
    nextActor: "coordinator",
    nextStep: "Draft the plan for review",
    note: "",
    createdMinutesAgo: 90,
    minutesAgo: 40,
  },
  {
    id: "fm-tablet-layout",
    agentId: FIRSTMATE_AGENT_ID,
    title: "Two-column layout for tablets",
    intent: "Use the space on tablets: list on the left, detail on the right.",
    definitionOfDone: "- Every screen works in the split view\n- Rotation keeps the selection",
    status: "in_progress",
    nextActor: "worker",
    nextStep: "Worker moving the settings screens",
    note: "",
    createdMinutesAgo: DAY,
    minutesAgo: 12,
    progress: {
      label: "Screens",
      kind: "count",
      unit: "screens",
      target: 24,
      history: [6, 11, 18],
    },
  },
  {
    id: "fm-composer-shortcuts",
    agentId: FIRSTMATE_AGENT_ID,
    title: "Keyboard shortcuts for the composer",
    intent: "Hardware keyboard users should send, attach, and switch models without the mouse.",
    definitionOfDone: "- Shortcuts listed in the help sheet\n- No conflicts with system shortcuts",
    status: "in_progress",
    nextActor: "worker",
    nextStep: "Worker adding shortcut hints",
    note: "",
    createdMinutesAgo: 6 * 60,
    minutesAgo: 25,
  },
  {
    id: "fm-widget-themes",
    agentId: FIRSTMATE_AGENT_ID,
    title: "Theme-aware home screen widget",
    intent: "The widget should follow the app's palette.",
    definitionOfDone: "- Widget matches every palette in light and dark",
    status: "backlog",
    nextActor: "coordinator",
    nextStep: null,
    note: "",
    createdMinutesAgo: 9 * DAY,
    minutesAgo: 9 * DAY,
  },
  {
    id: "fm-voice-notes",
    agentId: FIRSTMATE_AGENT_ID,
    title: "Voice notes in the composer",
    intent: "Record a voice note and send its transcript.",
    definitionOfDone: "- Transcript editable before sending",
    status: "backlog",
    nextActor: "coordinator",
    nextStep: null,
    note: "",
    createdMinutesAgo: 12 * DAY,
    minutesAgo: 12 * DAY,
  },
  {
    id: "fm-dark-icons",
    agentId: FIRSTMATE_AGENT_ID,
    title: "Dark app icon variants",
    intent: "Ship dark and tinted icons for iOS.",
    definitionOfDone: "- Dark and tinted icons in the asset catalog",
    status: "done",
    nextActor: "coordinator",
    nextStep: null,
    note: "",
    createdMinutesAgo: 4 * DAY,
    minutesAgo: DAY,
    closeEvidence: "Merged #455 and verified on device.",
  },
  {
    id: "fm-share-crash",
    agentId: FIRSTMATE_AGENT_ID,
    title: "Fix crash when sharing large images",
    intent: "Sharing a large photo into the app crashes it.",
    definitionOfDone: "- 50 MB images share without a crash",
    status: "done",
    nextActor: "coordinator",
    nextStep: null,
    note: "",
    createdMinutesAgo: 6 * DAY,
    minutesAgo: 2 * DAY,
    closeEvidence: "Merged #449; crash-free sessions back to 99.9%.",
  },
  {
    id: "rc-release-notes",
    agentId: "agent-release-captain",
    title: "Approve the 2.4 release notes",
    intent: "Write release notes for 2.4.",
    definitionOfDone: "- Notes approved and added to the submission",
    status: "in_review",
    nextActor: "user",
    nextStep: "Approve the release notes",
    note: "",
    createdMinutesAgo: 5 * 60,
    minutesAgo: 35,
  },
  {
    id: "gl-launch-post",
    agentId: "agent-growth-lead",
    title: "Draft the 2.4 launch post",
    intent: "A short post on the new composer and offline sending.",
    definitionOfDone: "- Draft with two screenshots",
    status: "in_progress",
    nextActor: "worker",
    nextStep: "Worker drafting the post",
    note: "",
    createdMinutesAgo: 3 * 60,
    minutesAgo: 20,
  },
];

interface ShowcaseAutomation {
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
  readonly schedule: Record<string, unknown>;
  readonly lastRunMinutesAgo: number;
  readonly nextRunMinutesFromNow: number;
  readonly lastRunStatus: "succeeded" | "failed";
  readonly lastRunError?: string;
  readonly runCount: number;
}

/** Firstmate's automations. Each next run is hours away, past any capture run. */
const SHOWCASE_AUTOMATIONS: ReadonlyArray<ShowcaseAutomation> = [
  {
    id: "automation-morning-triage",
    title: "Morning triage",
    prompt: "Review overnight issues and failed checks, then update the board.",
    schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
    lastRunMinutesAgo: 6 * 60,
    nextRunMinutesFromNow: 18 * 60,
    lastRunStatus: "succeeded",
    runCount: 37,
  },
  {
    id: "automation-release-health",
    title: "Release health check",
    prompt: "Check crash-free sessions and sync errors for the current release.",
    schedule: { type: "interval", everyMs: 12 * 60 * 60_000 },
    lastRunMinutesAgo: 2 * 60,
    nextRunMinutesFromNow: 10 * 60,
    lastRunStatus: "succeeded",
    runCount: 112,
  },
  {
    id: "automation-weekly-changelog",
    title: "Weekly changelog draft",
    prompt: "Draft this week's changelog from merged pull requests.",
    schedule: { type: "fixed_time", timeOfDay: "16:00", weekdays: [5] },
    lastRunMinutesAgo: 3 * DAY,
    nextRunMinutesFromNow: 4 * DAY,
    lastRunStatus: "failed",
    lastRunError: "The changelog branch had merge conflicts.",
    runCount: 9,
  },
];

function minutesBefore(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

function progressJson(progress: ShowcaseTaskProgress, now: number, minutesAgo: number): string {
  const { history, ...report } = progress;
  const value = history.at(-1) ?? 0;
  // One report every 40 minutes, the latest when the task last changed.
  const points = history.map((point, index) => ({
    value: point,
    at: minutesBefore(now, minutesAgo + (history.length - 1 - index) * 40),
  }));
  return JSON.stringify({
    ...report,
    value,
    updatedAt: minutesBefore(now, minutesAgo),
    history: points,
  });
}

export function seedShowcaseWork(
  database: NodeSqlite.DatabaseSync,
  now: number,
  input: {
    readonly projectId: string;
    readonly workerThreadIds: ReadonlyArray<string>;
    readonly artifactsRoot: string;
  },
): void {
  const seenAt = new Date(now).toISOString();
  database.exec("DELETE FROM firstmate_task_event");
  database.exec("DELETE FROM firstmate_task");
  database.exec(`DELETE FROM firstmate_agent WHERE agent_id <> '${FIRSTMATE_AGENT_ID}'`);
  database.exec("DELETE FROM scheduled_tasks");

  // The service inserts Firstmate's row as it starts; upsert in case it has
  // not got there yet.
  database
    .prepare(
      `INSERT INTO firstmate_agent (
        agent_id, slug, name, icon, color, role, coordinator_thread_id, home_project_id,
        model_selection_json, created_at, archived_at
      ) VALUES (?, ?, 'Firstmate', 'compass', 'sky', '', ?, NULL, NULL, ?, NULL)
      ON CONFLICT(agent_id) DO UPDATE SET coordinator_thread_id = excluded.coordinator_thread_id`,
    )
    .run(
      FIRSTMATE_AGENT_ID,
      FIRSTMATE_AGENT_ID,
      SHOWCASE_COORDINATOR_THREAD_ID,
      minutesBefore(now, 60 * DAY),
    );
  // An older build reads Firstmate's chat from here.
  database
    .prepare("UPDATE firstmate_config SET coordinator_thread_id = ? WHERE config_id = 1")
    .run(SHOWCASE_COORDINATOR_THREAD_ID);

  const insertAgent = database.prepare(
    `INSERT INTO firstmate_agent (
      agent_id, slug, name, icon, color, role, coordinator_thread_id, home_project_id,
      model_selection_json, created_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL)`,
  );
  for (const agent of SHOWCASE_AGENTS) {
    insertAgent.run(
      agent.id,
      agent.slug,
      agent.name,
      agent.icon,
      agent.color,
      agent.role,
      minutesBefore(now, agent.createdDaysAgo * DAY),
    );
  }

  const insertTask = database.prepare(
    `INSERT INTO firstmate_task (
      task_id, agent_id, title, intent, definition_of_done, state, status, next_actor, next_step,
      note, wake_at, worker_thread_id, links_json, artifacts_json, close_evidence, progress_json,
      priority, created_at, updated_at, closed_at, last_reported_run_id,
      last_terminal_notice_run_id, orphan_notified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
  );
  const insertEvent = database.prepare(
    `INSERT INTO firstmate_task_event (event_id, task_id, created_at, actor, summary)
      VALUES (?, ?, ?, ?, ?)`,
  );
  for (const task of SHOWCASE_TASKS) {
    const state = stateForStatus(task.status);
    const closed = state === "done" || state === "dropped";
    const updatedAt = minutesBefore(now, task.minutesAgo);
    const artifacts = (task.artifacts ?? []).map((artifact) =>
      artifact.kind === "image"
        ? { ...artifact, url: NodePath.join(input.artifactsRoot, task.id, artifact.url) }
        : artifact,
    );
    insertTask.run(
      task.id,
      task.agentId,
      task.title,
      task.intent,
      task.definitionOfDone,
      state,
      task.status,
      task.nextActor,
      task.nextStep,
      task.note,
      task.worker === undefined ? null : (input.workerThreadIds[task.worker] ?? null),
      JSON.stringify(task.links ?? []),
      JSON.stringify(artifacts),
      task.closeEvidence ?? null,
      task.progress === undefined ? null : progressJson(task.progress, now, task.minutesAgo),
      task.priority ? 1 : 0,
      minutesBefore(now, task.createdMinutesAgo),
      updatedAt,
      closed ? updatedAt : null,
      // Already reported as orphaned, so the reactor never wakes the coordinator.
      closed ? null : seenAt,
    );
    for (const [index, event] of (task.events ?? []).entries()) {
      insertEvent.run(
        `${task.id}-event-${index}`,
        task.id,
        minutesBefore(now, event.minutesAgo),
        event.actor,
        event.summary,
      );
    }
  }

  const insertAutomation = database.prepare(
    `INSERT INTO scheduled_tasks (
      task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
      workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by,
      creation_source, created_at, updated_at, next_run_at, last_run_at, last_run_status,
      last_run_error, run_count
    ) VALUES (?, ?, ?, 1, ?, ?, ?, '{"type":"root"}', ?, 'full-access', 'default', 'user',
      'mobile', ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const automation of SHOWCASE_AUTOMATIONS) {
    insertAutomation.run(
      automation.id,
      automation.title,
      automation.prompt,
      JSON.stringify(automation.schedule),
      input.projectId,
      SHOWCASE_COORDINATOR_THREAD_ID,
      MODEL_SELECTION,
      minutesBefore(now, 20 * DAY),
      minutesBefore(now, automation.lastRunMinutesAgo),
      new Date(now + automation.nextRunMinutesFromNow * 60_000).toISOString(),
      minutesBefore(now, automation.lastRunMinutesAgo),
      automation.lastRunStatus,
      automation.lastRunError ?? null,
      automation.runCount,
    );
  }
}

/**
 * Draws the detail task's review image: a startup trace, as rows of spans on a
 * timeline. Shapes only, so it renders the same on every capture host.
 */
export function renderStartupTracePng(): Buffer {
  const width = 1280;
  const height = 720;
  const png = new PNG({ width, height });
  const fill = (
    x: number,
    y: number,
    w: number,
    h: number,
    [r, g, b]: readonly [number, number, number],
  ) => {
    for (let row = Math.max(0, y); row < Math.min(height, y + h); row += 1) {
      for (let column = Math.max(0, x); column < Math.min(width, x + w); column += 1) {
        const offset = (row * width + column) * 4;
        png.data[offset] = r;
        png.data[offset + 1] = g;
        png.data[offset + 2] = b;
        png.data[offset + 3] = 255;
      }
    }
  };
  fill(0, 0, width, height, [17, 19, 24]);
  // Time grid.
  for (let x = 80; x < width; x += 120) fill(x, 40, 1, height - 80, [38, 42, 52]);
  // The 1,000 ms budget line.
  fill(1040, 40, 3, height - 80, [74, 222, 128]);
  const spans: ReadonlyArray<
    readonly [lane: number, start: number, length: number, color: readonly [number, number, number]]
  > = [
    [0, 80, 1080, [56, 189, 248]],
    [1, 80, 220, [129, 140, 248]],
    [1, 310, 300, [129, 140, 248]],
    [1, 620, 470, [129, 140, 248]],
    [2, 90, 140, [251, 191, 36]],
    [2, 330, 180, [251, 191, 36]],
    [2, 640, 120, [251, 191, 36]],
    [3, 340, 90, [244, 114, 182]],
    [3, 660, 260, [244, 114, 182]],
    [4, 700, 140, [45, 212, 191]],
    [4, 860, 200, [45, 212, 191]],
    [5, 960, 70, [148, 163, 184]],
  ];
  for (const [lane, start, length, color] of spans) {
    fill(start, 80 + lane * 96, length, 64, color);
  }
  return PNG.sync.write(png);
}

/** Writes the image artifacts where the seeded tasks point. */
export async function writeShowcaseWorkArtifacts(artifactsRoot: string): Promise<void> {
  const folder = NodePath.join(artifactsRoot, SHOWCASE_WORK_TASK_ID);
  await NodeFSP.mkdir(folder, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(folder, STARTUP_TRACE_FILE), renderStartupTracePng());
}
