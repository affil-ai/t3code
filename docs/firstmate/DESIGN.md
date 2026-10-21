# Firstmate and Agents

Firstmate is a coordinator chat. The user talks to one thread. It turns
requests into tracked tasks, starts one worker thread per task, and is woken
when a worker needs attention. The server keeps the task list. The
coordinator does not track tasks in its own context. Behavior lives in the
coordinator's home folder, not in the server.

**Agents** generalizes this: the same engine runs any number of agents, each
with its own coordinator chat, task board, worker chats, and wakes. Firstmate
is the reserved agent `firstmate`, with its own place in Work mode; the rest
are created by the user in Agents mode. See [Agents](#agents) below.

This is a fork-only feature. Keep it modular so upstream merges stay easy.

## Merge rules

- New code goes in new files:
  - `packages/contracts/src/firstmate.ts`
  - `apps/server/src/firstmate/`
  - `apps/server/src/mcp/toolkits/firstmate/`
  - `apps/web/src/components/firstmate/`
  - the new route file
- Edits to upstream files only add lines. Mark every such line with a
  `// fork: firstmate` comment. Expected touch points:
  - contracts `index.ts` and `rpc.ts`
  - server `server.ts`, `ws.ts`, and `mcp/McpHttpServer.ts`
  - web `LegacySidebar.tsx` and the generated route tree
  - the right panel's `firstmate` surface: a union member and singleton case
    in `rightPanelStore.ts`, a title and icon case in `RightPanelTabs.tsx`,
    and one render-chain branch in `ChatView.tsx`, each delegating to
    `components/firstmate/firstmateTab.tsx`. Whether a surface can be closed
    comes from `components/firstmate/firstmateSurface.ts`.
  - orchestration: `Orchestrator.ts` lets server notifications steer or start
    a run, and handles the server-only `queued-notification.revise` command;
    `ThreadManagementService.ts` passes an optional notification through
    `sendToThread`.
- Do not add to the shared migration list. Upstream numbers its migrations,
  and a fork migration would collide. Create the Firstmate tables at service
  start with `CREATE TABLE IF NOT EXISTS`. All table names start with
  `firstmate_`, the agent table included (`firstmate_agent`), so an
  installed database carries over without a rename.
- Agents mode adds `components/agents/` and `state/agents.ts` on the web, a
  `"agents"` member of `AppMode` and `APP_MODE_OPTIONS`, and one marked
  branch in `LegacySidebar.tsx` that renders `<AgentsSidebar />`.
- Do not change the orchestration thread model. The link from a worker to its
  coordinator is the task row.

## Data

`firstmate_task`:

| Field                                | Meaning                                                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                 | Branded `FirstmateTaskId`                                                                                                                                        |
| `title`                              | Short label                                                                                                                                                      |
| `intent`                             | The user's request in their own words                                                                                                                            |
| `definitionOfDone`                   | What closes the task                                                                                                                                             |
| `status`                             | Explicit lifecycle: `backlog`, `planning`, `in_progress`, `in_review`, `ready_for_deployment`, `monitoring` (live, post-release checks open), `done`, `canceled` |
| `state`                              | Legacy operational value, maintained from status by the service; old callers may still write it                                                                  |
| `nextActor`                          | `coordinator`, `worker`, `user`, or `external`                                                                                                                   |
| `note`                               | One-line current status                                                                                                                                          |
| `wakeAt`                             | ISO time or null                                                                                                                                                 |
| `workerThreadId`                     | Null, or one worker thread. A task has at most one live worker; replacing it overwrites the field and logs an event.                                             |
| `links`                              | Array of `{label, url}`, such as PRs and reports                                                                                                                 |
| `closeEvidence`                      | Required when the state becomes `done` or `dropped`                                                                                                              |
| `createdAt`, `updatedAt`, `closedAt` | Timestamps                                                                                                                                                       |
| `lastReportedRunId`                  | Internal; dedupes worker wakes                                                                                                                                   |
| `orphanNotifiedAt`                   | Internal; dedupes orphan wakes                                                                                                                                   |

`firstmate_task_event` is append-only. Each row has an id, a task id, a time,
an actor (`coordinator`, `user`, or `system`), and a summary. Every create and
update writes one row.

`firstmate_config` is a single row holding `coordinatorThreadId`, which is
null until set, `homeProjectId`, which is null until the first start, plus the
user's `name` (default "Firstmate") and `icon` (default "compass"). Columns added after the first release are added at
service start when `PRAGMA table_info` shows them missing.

## Server

`apps/server/src/firstmate/`, one concern per file:

| File                                    | What it holds                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `store.ts`                              | The tables, their startup creation, and row ↔ task mapping                      |
| `FirstmateService.ts`                   | Task and config operations, and the board's subscription stream                 |
| `FirstmateReactor.ts`                   | When to wake the coordinator, and delivering the wake                           |
| `wakeDigest.ts`                         | What a wake says: the digest text, its timeline row, and folding wakes together |
| `FirstmateHome.ts`, `homeFiles.ts`      | The coordinator's home folder and the files seeded into it                      |
| `coordinatorPrompt.ts`                  | The coordinator chat's first message                                            |
| `rpc.ts`, `runtimeLayer.ts`, `index.ts` | Wiring into the server's RPC and runtime                                        |

The web side follows the same split in `apps/web/src/components/firstmate/`:
`firstmateBoard.logic.ts` (columns, pure), `FirstmateTasksPanel.tsx` (the
list), `FirstmateTaskDetail.tsx`, `FirstmateTaskLinks.tsx`,
`FirstmateTaskArtifacts.tsx`, and `firstmateTasksShared.ts` (labels and the
coordinator context they share).

`FirstmateReactor` uses no model. It is woken by orchestration events where
possible and otherwise sweeps every 30 seconds. It collects wake reasons:

- A task's worker thread has a new terminal run (completed, failed, or
  interrupted) whose id is not `lastReportedRunId`.
- A task's worker thread is waiting on a user-input or approval request.
- `wakeAt` has passed.
- An orphan: the task is open, has no `wakeAt`, has `nextActor` of
  `coordinator` or `worker`, has no running worker, and has seen no event for
  10 minutes. Wake for an orphan once until the task is updated again.

Each pass sends at most one message to the coordinator thread, as a
`monitor` notification: the timeline shows one compact "Firstmate: N updates"
row that expands to the digest. It uses `sendToThread` with `mode: "auto"`,
so a wake steers into the coordinator's active turn when it can. If a wake is
still queued, the pass folds into it with `queued-notification.revise`
instead of queueing a second: at most one wake ever waits. The digest has one
line per task with its id, title, and reasons. It ends with:

> Reconcile with firstmate_task_list, update every task you touch, and tell
> the user only about outcomes and decisions.

If no coordinator is set, the reactor does nothing.

## MCP tools

These live in `apps/server/src/mcp/toolkits/firstmate/`. Follow the
`pullRequests` toolkit's shape.

| Tool                    | Access           | Purpose                                                                                                     |
| ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `firstmate_task_list`   | Any thread       | Filter by state. Defaults to every task that is not closed.                                                 |
| `firstmate_task_get`    | Any thread       | One task with its events                                                                                    |
| `firstmate_task_create` | Coordinator only | Create a task                                                                                               |
| `firstmate_task_update` | Coordinator only | Partial update. Requires an event `summary`. Moving a task to `done` or `dropped` requires `closeEvidence`. |

Mutations from any other thread return a clear error.

The agent tools let one agent watch and shape the others, for example a chief
agent that monitors the rest. Coordinator chats retain cross-agent access.
Approved external MCP clients can discover agents and read explicitly targeted
boards and tasks without impersonating a coordinator. Workers and ordinary
thread credentials cannot use these cross-agent tools. Agent creation and
profile updates remain coordinator-only.

| Tool           | Purpose                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `agent_list`   | The unarchived agents: id, name, role, icon, color, coordinator chat                                                           |
| `agent_tasks`  | Another agent's board, read-only, filtered by state like `firstmate_task_list`                                                 |
| `agent_create` | Same as `agents.create`. Icon defaults to `bot`, color to the agent default, and the model to the calling agent's recorded one |
| `agent_update` | Same as `agents.update`: name, icon, color, or role                                                                            |

## Client RPC

Follow the `scheduledTasks.*` pattern in `rpc.ts` and `ws.ts`:

- `firstmate.subscribe` streams `{ coordinatorThreadId, name, icon, tasks }`.
- `firstmate.getTask` returns a task with its events.
- `firstmate.setCoordinator({ threadId | null })` sets or clears the
  coordinator.
- `firstmate.start({ modelSelection })` prepares the home project (below),
  then launches a coordinator thread at its root (`workspaceStrategy: root`)
  through the thread-creation path scheduled tasks use for a fresh thread. It
  sets the new thread as coordinator. The thread is titled with the
  configured name, and its first message is the short kickoff from
  `coordinatorPrompt.ts`, which points the agent at `AGENTS.md` and `notes/`.
- `firstmate.setAppearance({ name, icon })` saves the name and icon, renames
  the coordinator chat with a `thread.metadata.update` command (the path a
  thread rename takes), and retitles the home project through
  `ProjectService.update`. `icon` is any short key; clients draw a key they
  do not know as the compass.

## Home repository

The coordinator's steering is files, not a prompt the server holds, so the
provider harness loads it the way it loads any project's
(`apps/server/src/firstmate/FirstmateHome.ts`):

- One repository holds every agent: `~/agents` for the server's user, or
  `T3CODE_AGENTS_HOME` when set. Its root has the instructions every agent
  follows (`AGENTS.md`, with `CLAUDE.md` importing it), shared `notes/` and
  `.agents/skills/` (linked from `.claude/skills`), and `artifacts/` for kept
  review images, which Git ignores.
- Each agent owns `crew/<slug>/`: its own `AGENTS.md` (the role between
  `<!-- role -->` markers, then its standing instructions), `CLAUDE.md`,
  `notes/`, and `.agents/skills/` with the same `.claude/skills` link. The
  agent's chat runs in a T3 project rooted there, so Claude Code walks up to
  the shared file and Codex layers both.
- Each start creates any missing seed file (`homeFiles.ts`) at the root and
  in the agent's folder. A file that exists is never rewritten, so user
  edits win and deleting a file restores the seed. `writeRole` replaces only
  the text between the role markers.
- A start commits only the seed paths it added, falling back to
  `Firstmate <firstmate@localhost>` when Git has no identity. A failed
  commit leaves the files and still starts.
- The project is found by workspace root, or created with
  `ProjectService.bootstrap` and titled with the agent's name.
- **One-time move.** A `~/firstmate` (or `T3CODE_FIRSTMATE_HOME`) from before
  agents is moved into `crew/firstmate` at the first service start that
  finds no `~/agents`. Its `.git` moves up to become the repository's, so
  Firstmate's history is kept and the move is one commit of renames; its
  kept images move to the root `artifacts/`, their stored paths are
  rewritten, the shared root files are seeded, and Firstmate's project is
  repointed with `project.update`. A copy of the old folder stays as
  `~/firstmate.bak-<time>` until the user deletes it.
- **Move into `crew/`.** Agents' folders were first under `agents/`, so the
  repository read as `~/agents/agents/<slug>`. Each start moves any
  `agents/<slug>` without a `crew/<slug>` into `crew/`, commits only those
  paths as renames, removes the emptied `agents/`, and repoints each agent's
  project.

The shared instructions cover the task rules: every request is a task
recorded verbatim with a definition of done, one worker per task in a new
worktree, reconcile from `firstmate_task_list` after every wake, close only
with evidence, and talk in outcomes. They also have each agent read the
shared and its own `notes/` each session, write lasting learnings there, and
write skills on request.

## Agents

- **Data.** `firstmate_agent` holds one row per agent: `agent_id`, `slug`
  (its folder name), `name`, `icon`, `color`, `role`, `coordinator_thread_id`,
  `home_project_id`, `model_selection_json`, `created_at`, `archived_at`.
  `firstmate_task` has `agent_id`, defaulting to `firstmate` so tasks from
  before agents keep their owner. At startup the `firstmate_config` row is
  copied once into the agent table as `firstmate`; Firstmate's settings are
  mirrored back into `firstmate_config` afterwards so an older build can
  still read them.
- **Service.** Every task operation takes an `agentId`. A task owned by a
  different `agentId` is "not found". Cross-agent readers must name the owner.
  Firstmate's
  RPCs call with `FIRSTMATE_AGENT_ID`. `agentForThread` finds the agent a
  calling thread acts for: its own coordinator chat, or a worker on one of
  its tasks.
- **MCP.** The `firstmate_task_*` tools resolve the agent from the calling
  thread. A coordinator may read and change its board; a worker may read its
  agent's board; any other thread is refused. External clients use explicit
  `agentId` targets for crew reads. Agent automation ownership follows the
  existing UI rule, a schedule bound to that agent's coordinator thread.
  Reads omit webhook endpoints because their tokens can start work. Automation
  edits and deletes require write approval covering the saved schedule modes
  and the coordinator's current modes, with an atomic bound-thread check at
  persistence to reject concurrent rebinding.
- **Reactor.** One sweep groups open tasks by agent and sends each agent's
  wakes to its own chat, folding into that chat's queued wake as before.
- **RPCs.** `agents.subscribe` streams the unarchived agents;
  `agents.tasks.subscribe({ agentId })` streams one agent's board, shaped
  like Firstmate's snapshot; `agents.create` records the agent, seeds its
  folder, and starts its chat; `agents.update` changes name, icon, color, or
  role (rewriting the role in its `AGENTS.md`); `agents.archive` hides the
  agent (Firstmate cannot be archived); `agents.start` starts a new chat for
  an agent whose chat is gone.
- **Sidebar.** Agents live in the Work sidebar; there is no Agents mode (a
  saved one reads as Work). `AgentSwitcher` draws the selected agent as one
  large row under Search, with a colored icon tile (the project icon
  palette), the name, and the role on one line, or the chat's live status
  when it is working, waiting, or failed, and a badge counting tasks that
  need the user. Its chevron opens a menu listing every agent, "New agent…",
  "Edit name, role, and icon…" (Firstmate: "Name and icon…"), and "Archive
  agent" (not for Firstmate); a right-click offers edit and archive too.
  Under the row, `AgentSidebarSections` shows the agent's open tasks (a
  task with a worker opens the worker's chat) and an **Automations** section
  listing the scheduled tasks bound to its chat, each opening the editor.
  Firstmate's sidebar continues with a divider and the Pinned, Projects,
  and Chats lists. Automations is the one name for scheduled and webhook
  tasks in the fork's UI; the server keeps its `scheduledTasks` names. A custom
  agent's sidebar ends there, so its worker chats are reached from its
  tasks; those chats, every coordinator chat, and agent home projects stay
  out of the Work list. The selected agent is kept per client
  in `selectedAgentStore.ts`; an archived or missing choice falls back to
  Firstmate. A hosted sign-in other than Vivek's prefers the first custom
  agent until the user picks one.
- **Create dialog.** Name, role, icon (the Firstmate icon grid), and color.
  Creating uses the model a fresh Scratch chat would open with, then opens
  the new chat with its Tasks tab.
- **Tasks panel.** The `firstmate` right-panel surface shows the board of
  whichever agent's coordinator chat is open, resolved from the agent list;
  Firstmate's own stream is the fallback. Its menu edits the agent (the
  Firstmate name-and-icon dialog for Firstmate; the agent dialog otherwise).
  An **Automations** section closes the panel: the scheduled tasks bound to the
  chat, live from `scheduledTasks.subscribe`, each with its schedule, next
  run, edit, run-now, and pause; a "+" opens the scheduled-tasks settings.

## Web

- Firstmate is the coordinator's normal chat route with the full `ChatView`.
  Its task list is the right panel's `{ id: "firstmate", kind: "firstmate" }`
  surface, a singleton tab like Agents. The tab is opened whenever the
  coordinator chat becomes the route; the user can close it like any tab.
  Clicking the sidebar row, or coming back to the chat, opens it again.
- Route `apps/web/src/routes/_chat.firstmate.$environmentId.tsx` forwards to
  the coordinator chat. With no coordinator set, it shows an empty state with
  one "Start Firstmate" button. It calls `firstmate.start` with the model a
  new Scratch chat would open with (`firstmateModel.ts` runs the composer's
  own resolvers), then opens the new chat. A deleted coordinator gets a "Stop
  using this chat" button instead.
- The panel is narrow: sections stack vertically, mapped in a pure, tested
  logic file. Lifecycle sections use explicit `status`. Changing `nextActor`
  does not move a task between these sections.
  - Needs you is a separate attention view for tasks whose next actor is the
    user, excluding backlog and closed work. The same task remains in its
    lifecycle section. Deployment decisions also appear in Needs you.
  - All work contains Backlog, Planning, In progress, In review, Ready for
    deployment, and Done. Backlog and Done are collapsed in the panel.
  - Backlog is intentionally parked. The reactor ignores it and removes its
    queued wakes. Parking clears `wakeAt` and rejects a linked active worker;
    it never stops a worker. Promotion is an explicit status update.
  - Done includes completed and canceled work; keep the latest 20.
  - Old rows receive a status at startup. Old wire payloads use the same
    compatibility mapping. `state` updates from old callers still work, but
    new callers should send `status` and let the service maintain `state`.
- A card shows the title, the worker chat link, status, and age, plus its
  links. Clicking it drills into the task inside the panel, with a back
  button: the intent, the definition of done, the close evidence, review
  artifacts, links, and the event log. Artifacts appear only in the detail,
  so the list stays clean. The Tasks tab cannot be closed.
- The panel's menu offers "Name and icon…", a dialog with a name field and a
  grid of twelve lucide icons (`firstmateIcons.tsx`), and "Stop using this
  chat", which calls `setCoordinator(null)` and brings the Start button back.
- The Work sidebar lists Work projects, not server projects, so the home
  project shows no row there; the coordinator is left out of its chat lists.
  A new Work chat skips the home project when it picks a repository to run
  in. Code mode lists the home project like any other.
- Sidebar: in Work mode, directly below Search in `LegacySidebar.tsx`, render
  `<AgentSwitcher />` from `components/agents/` (see Agents). With Firstmate
  selected it shows the chosen name and icon with a badge counting Needs-you
  tasks. It targets the first connected environment whose server answers
  `agents.subscribe`, and it is hidden when none does, as with a stock server.
