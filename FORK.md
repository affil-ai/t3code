# T3 Work

T3 Work is a fork of T3 Code. Most changes are in the desktop and web client
and still work against an unmodified T3 server of the same version.
**Firstmate** changes the server, so it needs this fork's server.
Against a stock server, Firstmate is hidden.

Read [`CONTEXT.md`](CONTEXT.md) for the fork's canonical source, release
language, and ownership boundaries.

## Affil ownership boundaries

- The canonical fork is `affil-ai/t3code`.
- Keep `upstream` pointed at `pingdotgg/t3code`.
- Fork releases use the repository-owned host-local workflow. They do not use
  GitHub Actions release channels.
- Ubuntu is the Linux build and web-publication host.
- The Mac is the macOS build, signing, and app-installation host.
- `t3.olumbe.com` is the private web target for the paired release.
- Firstmate server and client code must be released from this fork together.
- Office worker source remains in `affil-ai/nextcard`.
- Do not copy the machine repository, credentials, SSH keys, Cloudflare
  configuration, or private runtime state into this repository.

## Fork changes and merge rules

| Area                                      | Server change | Location                                                       |
| ----------------------------------------- | ------------- | -------------------------------------------------------------- |
| Code and Work modes, Work sidebar         | No            | `apps/web/src/components/work/`, `LegacySidebar.tsx`           |
| Chat dock                                 | No            | `apps/web/src/components/work/DockChatPanel.tsx`               |
| Desktop app identity and data directories | No            | `apps/desktop/src/app/`, `scripts/lib/brand-assets.ts`         |
| Firstmate                                 | **Yes**       | See [Firstmate](#firstmate)                                    |
| Detached service updates                  | **Yes**       | `apps/server/src/cli/managedProcessTree.ts`                    |
| Release build dependency pinning          | No            | `scripts/lib/pin-patched-dependencies.ts`                      |
| Chat bridge app for stock T3 (Slack)      | No            | `apps/chat-bridge/` (its [README](apps/chat-bridge/README.md)) |

Keep fork code in its own files. When an upstream file must change, limit the
edit to an import plus one registration line, and mark it with a
`// fork: <feature>` comment. To list every such edit, run
`git grep -n "fork: "`. Upstream merges then conflict only on those lines.
Generated files, such as `apps/web/src/routeTree.gen.ts`, carry no markers. If
one conflicts, regenerate it instead of editing it. Do
not add fork migrations to the numbered upstream migration list: fork tables
are created at service start and use a feature prefix, such as `firstmate_`.

## Code and Work modes

The sidebar brand ("T3 Code" / "T3 Work") is a menu that switches modes. The
choice is stored locally under `t3work:work-mode:v1`.

- **Code** is upstream T3 Code: the project sidebar, terminal, actions, Open
  in, and Git controls.
- **Work** hides the coding controls:
  - the header's actions, Open in, and Git controls
  - the diff shortcut and Pull Requests
  - the terminal, diff, pull request, and device surfaces in the right panel

  It keeps the bottom terminal drawer with its toggle and shortcuts, and the
  workspace and branch strip under the composer. The workspace is the current
  checkout or worktree.

### Work sidebar

The Work sidebar has two sections (`apps/web/src/components/LegacySidebar.tsx`,
`apps/web/src/components/work/workChats.logic.ts`):

- **Projects** includes user-created Work projects and registered repositories.
  Repository rows keep the Code sidebar's environment grouping and chat actions.
- **Chats** lists every chat that is not in a project.

To file a chat, drag it onto a project or use its context menu. To unfile it,
drop it on Chats. Deleting a Work project moves its chats back to Chats.

Work projects and filings sync through `/api/t3work/state` on the first
connected environment that serves that route. The T3 server does not provide
it, so a deployment that wants sync needs a small HTTP service in front of the
server. Filings record which project each `environmentId:threadId` belongs to;
they do not change server threads, which still run in a repository project.
Collapsed state, mode, and the default project are stored per device.

A chat that an agent creates through the orchestration API can name its
parent by starting its first message with `<!-- t3work-parent: <thread ID> -->`.
The app files the chat in the parent's Work project and hides the marker
(`apps/web/src/components/work/threadParent.logic.ts`). Once per app session,
the app loads each unfiled chat created in the last two days and checks it
for the marker.

### Chat rows

The chat header shows a machine icon for chats on another machine. A Work
chat row starts with that machine icon and ends with one status icon, with no
label. Row icons reserve no columns: they pack against the row's end, and on
hover the archive button takes the status icon's place (`ThreadStatusIcon` in
`apps/web/src/components/ThreadStatusIndicators.tsx`). The status icons are:

- a rotating dashed circle for Working and Connecting, which keeps rotating
  under Reduce Motion
- still icons for Monitoring (an eye), approval, input, Plan Ready, and Failed
- a dot for an unseen completion

## Chat dock

In both modes, the right panel's **Chat** surface shows another chat beside
the main thread (`apps/web/src/components/work/DockChatPanel.tsx`).

Its picker can start a new chat in the main chat's project or open any
existing chat on any machine. Existing chats are grouped in three sections
(`DockChatPanel.logic.ts`):

1. the main chat's Work project
2. its repository
3. the 30 most recent other chats

A chat tab records its environment when that differs from the main chat's.

The docked chat is the real `ChatView` in embedded mode (the `embedded`
prop). It has the same timeline, composer, and workspace strip, but no header,
right panel, or terminal, and it does not change the route.

- A new chat starts in the main chat's worktree, or in its checkout when it
  has none. The workspace strip can switch it to a new worktree.
- Until its first message, the draft lives in the view's state, not the draft
  store, so it adds no sidebar row (`apps/web/src/components/localDraftSession.ts`).
- Window-level shortcuts, typing, and paste go to the chat that has focus or
  was clicked last (`apps/web/src/components/chat/composerEventScope.ts`).
- Clicking into one chat blurs the other chat's composer, which collapses to
  its compact bar.

## Firstmate and Agents

Firstmate is one coordinator chat that the user talks to about all of their
work. It records each request as a task on the server, starts one worker
thread per task, and is woken when a worker finishes, fails, or needs input.
It is also woken when a task's wake time passes or a task has no one working
on it. The task list lives on the server, not in the coordinator's context.

**Agents** run any number of such coordinators on the same engine. Each agent
is a chat with its own task board, worker chats, and wakes; Firstmate is the
reserved agent `firstmate`. There is no separate Agents mode: the Work sidebar
shows one agent at a time. Its row below the titlebar (icon tile, name, role or live
status, a badge counting tasks waiting on the user) has a switcher listing
every agent, plus "New agent", edit, and archive. Firstmate's sidebar continues
with its tasks, its automations, and the usual Pinned, Projects, and Chats; a
custom agent's sidebar holds only its tasks and automations (the same two sections Firstmate starts with), and its worker
chats are reached from the tasks. The choice is kept per client. On
`t3.olumbe.com`, a sign-in other than Vivek's opens on the first custom agent.

Every agent's chat runs in its folder of one repository, `~/agents` on the
server (override with `T3CODE_AGENTS_HOME`): shared `AGENTS.md`, `notes/`,
and `.agents/skills/` at the root, and `crew/<slug>/` per agent with its own
`AGENTS.md` (its role at the top), `notes/`, and skills. Seed files are
committed there and never overwritten. A pre-agents `~/firstmate` is moved
into `crew/firstmate` once, keeping its history and project. Agents' folders
were first under `agents/`, which read as `~/agents/agents/<slug>`; they move
to `crew/` once, in one commit of renames, with their projects repointed.

[`docs/firstmate/DESIGN.md`](docs/firstmate/DESIGN.md) specifies the data,
tools, wake rules, and UI.

| Piece                                              | Location                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Contracts                                          | `packages/contracts/src/firstmate.ts`                                                                   |
| Server: agents, task store, wake reactor, home     | `apps/server/src/firstmate/`                                                                            |
| MCP tools (`firstmate_task_*`)                     | `apps/server/src/mcp/toolkits/firstmate/`                                                               |
| Tasks panel, sidebar link, route                   | `apps/web/src/components/firstmate/`, `apps/web/src/routes/_chat.firstmate.*`                           |
| Agent switcher, sidebar sections, dialog           | `apps/web/src/components/agents/`, `apps/web/src/state/agents.ts`, `apps/web/src/selectedAgentStore.ts` |
| Tables (created at server start, not by migration) | `firstmate_agent`, `firstmate_task`, `firstmate_task_event`, `firstmate_config`                         |

In Work mode, the selected agent's row sits below the titlebar in the sidebar. It
opens the coordinator chat with the right panel closed. Open **Tasks** when
you need the board. On mobile, choosing an agent or chat closes the sidebar.
The panel shows whichever agent's
chat is open, ends with that chat's **Automations**, and its menu renames
the agent and changes its icon for every client.

Firstmate and Agents need this fork's server: build and run the server from
this repository, not the published `t3` package. The client hides them on any
environment whose server does not answer `firstmate.subscribe` or
`agents.subscribe`.

## Desktop app

The packaged app is named `T3 Work`. Its bundle ID, data directories, and icon
are set in `apps/desktop/src/app/DesktopEnvironment.ts`,
`apps/desktop/src/app/DesktopUserData.ts`, `scripts/build-desktop-artifact.ts`,
and `scripts/lib/brand-assets.ts`. Change them before you distribute your own
build.

The app keeps its desktop state, including saved connections and client
settings, apart from the upstream app's, so it needs its own pairing. Do not
copy credentials between the two apps. Its local backend shares the upstream
app's `~/.t3` server state, so local threads appear in both apps
(`apps/desktop/src/backend/DesktopSharedBackendHome.ts`). Never run both
apps' local backends at once. If the upstream app's backend is already
running, T3 Work starts its local backend in its own directory and shows no
local threads until it is relaunched with the upstream app closed. T3 Work
does not register as the macOS handler for `t3code://` links, so the upstream
app can stay installed. There is no automatic update feed.

The icon's vector source is `assets/fork/office-vo-macos.svg`. Regenerate the
PNG after changing it:

```sh
sips -s format png assets/fork/office-vo-macos.svg \
  --out assets/fork/office-vo-macos-1024.png
```

### Build

Install dependencies with `vp i`. Set the release package versions so the app
and its bundled server report the artifact version, then build with the same
version as the server you connect to. Keep the repository's
`node_modules/.bin` first on `PATH`: the build installs into a staging folder
without `node_modules`, where a global `vp` shim can recurse through
`pnpm exec`.

```sh
node scripts/update-release-package-versions.ts <version>
PATH="$PWD/node_modules/.bin:$HOME/.cargo/bin:$PATH" \
  env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
  --build-version <version>
```

The DMG and ZIP go to `release/`. Use the fork-owned
[paired release workflow](docs/operations/fork-release.md) to sign, stage,
and install the app. Its detached installer waits for idle, quits gracefully,
and relaunches through LaunchServices. Never overwrite a running app bundle.

Sign with a stable certificate, not ad hoc (`--sign -`). An ad hoc signature
changes with every build, so macOS treats each build as a new app and asks
again for the "t3code Safe Storage" keychain item, even after "Always Allow".
Distribution to another Mac requires Developer ID signing and notarization.

## Taking upstream releases

Keep `upstream` pointed at `pingdotgg/t3code`. Merge the selected upstream
release tag, then resolve conflicts:

- Upstream files carry only the lines marked `// fork:`.
- Fork features live in their own files.

Rebuild with that release's version. Because Firstmate changes the server,
deploy the server from this fork at the same version; do not install the
published package.
