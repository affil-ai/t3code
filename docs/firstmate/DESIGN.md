# Firstmate

Firstmate is a global coordinator chat. The user talks to one thread. It turns
requests into tracked tasks, starts one worker thread per task, and is woken
when a worker needs attention. The server keeps the task list. The
coordinator does not track tasks in its own context. Behavior lives in the
coordinator's prompt and skills, not in the server.

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
    `components/firstmate/firstmateTab.tsx`
- Do not add to the shared migration list. Upstream numbers its migrations,
  and a fork migration would collide. Create the Firstmate tables at service
  start with `CREATE TABLE IF NOT EXISTS`. All table names start with
  `firstmate_`.
- Do not change the orchestration thread model. The link from a worker to its
  coordinator is the task row.

## Data

`firstmate_task`:

| Field                                | Meaning                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `id`                                 | Branded `FirstmateTaskId`                                                                                            |
| `title`                              | Short label                                                                                                          |
| `intent`                             | The user's request in their own words                                                                                |
| `definitionOfDone`                   | What closes the task                                                                                                 |
| `state`                              | `open`, `waiting`, `done`, or `dropped`                                                                              |
| `nextActor`                          | `coordinator`, `worker`, `user`, or `external`                                                                       |
| `note`                               | One-line current status                                                                                              |
| `wakeAt`                             | ISO time or null                                                                                                     |
| `workerThreadId`                     | Null, or one worker thread. A task has at most one live worker; replacing it overwrites the field and logs an event. |
| `links`                              | Array of `{label, url}`, such as PRs and reports                                                                     |
| `closeEvidence`                      | Required when the state becomes `done` or `dropped`                                                                  |
| `createdAt`, `updatedAt`, `closedAt` | Timestamps                                                                                                           |
| `lastReportedRunId`                  | Internal; dedupes worker wakes                                                                                       |
| `orphanNotifiedAt`                   | Internal; dedupes orphan wakes                                                                                       |

`firstmate_task_event` is append-only. Each row has an id, a task id, a time,
an actor (`coordinator`, `user`, or `system`), and a summary. Every create and
update writes one row.

`firstmate_config` is a single row holding `coordinatorThreadId`, which is
null until set, plus the user's `name` (default "Firstmate") and `icon`
(default "compass"). Columns added after the first release are added at
service start when `PRAGMA table_info` shows them missing.

## Server

`apps/server/src/firstmate/FirstmateService.ts` holds the store and its
operations, plus the subscription stream for the board.

`FirstmateReactor` uses no model. It is woken by orchestration events where
possible and otherwise sweeps every 30 seconds. It collects wake reasons:

- A task's worker thread has a new terminal run (completed, failed, or
  interrupted) whose id is not `lastReportedRunId`.
- A task's worker thread is waiting on a user-input or approval request.
- `wakeAt` has passed.
- An orphan: the task is open, has no `wakeAt`, has `nextActor` of
  `coordinator` or `worker`, has no running worker, and has seen no event for
  10 minutes. Wake for an orphan once until the task is updated again.

Each pass sends at most one message to the coordinator thread. It uses
`ThreadManagementService.sendToThread` with `mode: "queue"`, the same way
scheduled tasks post into a bound thread. The message is a short digest: one
line per task with its id, title, and reason. It ends with:

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

## Client RPC

Follow the `scheduledTasks.*` pattern in `rpc.ts` and `ws.ts`:

- `firstmate.subscribe` streams `{ coordinatorThreadId, name, icon, tasks }`.
- `firstmate.getTask` returns a task with its events.
- `firstmate.setCoordinator({ threadId | null })` sets or clears the
  coordinator.
- `firstmate.start({ modelSelection })` creates a coordinator thread in the
  Scratch project (`ManagedProjectFolders.ensureScratchProject`, as an MCP
  `scratch: true` launch does; the root launch claims the thread's own
  folder). It reuses the thread-creation path that scheduled tasks use to
  start a fresh thread, sends `defaultCoordinatorPrompt` from
  `apps/server/src/firstmate/coordinatorPrompt.ts` as the first message, and
  sets the new thread as coordinator. The thread is titled with the
  configured name.
- `firstmate.setAppearance({ name, icon })` saves the name and icon and
  renames the coordinator chat with a `thread.metadata.update` command, the
  same path a thread rename takes. `icon` is any short key; clients draw a
  key they do not know as the compass.

## Default coordinator prompt

Keep it short. Users customize the coordinator with their own skills and
rules.

- You are Firstmate, the user's single point of contact. Every request becomes
  a Firstmate task: record the user's intent verbatim and a definition of
  done.
- Do not do project work yourself. Start one worker thread per task with
  `t3_thread_launch` and a new worktree. Record its thread id with
  `firstmate_task_update`. To steer the worker or send it a follow-up, use
  `t3_thread_send`.
- After every wake, reconcile from `firstmate_task_list` rather than from
  memory. Every open task must have a next actor, plus either a running worker
  or a `wakeAt`.
- Close a task only with evidence: a merged PR, a delivered report, or the
  user's acceptance. Never merge a PR or discard work without the user's
  explicit word. A decision for the user is a task whose `nextActor` is
  `user`.
- Talk in outcomes and decisions, and include PR URLs. Do not report internal
  mechanics.

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
  logic file:
  - Needs you: `nextActor` is `user`.
  - In progress: `nextActor` is `worker` or `coordinator`.
  - Waiting: `state` is `waiting`, or `nextActor` is `external`.
  - Done: `done` or `dropped`. Show the latest 20, collapsed by default.
- A card shows the title, note, age, and next actor, plus links to the worker
  thread and PRs. Clicking it drills into the task inside the panel, with a
  back button: the intent, the definition of done, the close evidence, and
  the event log.
- The panel's menu offers "Name and icon…", a dialog with a name field and a
  grid of twelve lucide icons (`firstmateIcons.tsx`), and "Stop using this
  chat", which calls `setCoordinator(null)` and brings the Start button back.
- Sidebar: in Work mode, directly below Search in `LegacySidebar.tsx`, render
  `<FirstmateSidebarLink />` from `components/firstmate/`. It shows the
  chosen name and icon with a badge counting Needs-you tasks. It targets the
  first connected environment whose server answers `firstmate.subscribe`,
  and it is hidden when none does, as with a stock server.
