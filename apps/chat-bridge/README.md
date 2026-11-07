# T3 chat bridge

Talk to T3 Code agents from Slack, iMessage, Linear, and Office. Mention the bot in a mapped channel and it
starts a T3 thread in that channel's project. Replies in the Slack thread go to
the same T3 thread. Each run shows in Slack as it works, with Slack's own agent
features, and ends with the agent's final message.

It works with stock T3 Code. The bridge is a separate process that talks to T3
through T3's MCP endpoint, the same one Claude and Codex use, and to Slack over
Socket Mode, so it needs no public URL.

## What it does

- **A mention starts a thread.** The bridge launches a T3 thread in the
  channel's project with the message, who sent it, and any attached files.
- **A direct message starts a thread too**, in `dmProjectId`. Each top-level
  direct message is its own thread; replies under it continue that thread.
- **A mention inside a Slack thread brings the thread along.** The first turn
  includes the messages before the mention, oldest first, within 80,000
  characters (the newest are kept). Each message shows its author and Slack id,
  so the agent can tag them. Their files are imported with the mention's own.
  Messages from people outside `allowedUserIds` are included as context too.
- **Replies continue it.** A reply steers the run in flight, on every platform,
  or starts a new run if the thread is idle. Nothing waits for the run to end.
- **Some replies are only context.** A reply that starts with "aside", one that
  mentions another bot, and one from someone outside `allowedUserIds` start no
  run. The agent sees them, up to the newest 50, with the next message it gets.
- **Mute.** `@bot mute` in a thread makes the bot answer only messages that
  mention it; the rest become context. `@bot unmute` undoes it.
- **Status shows what the agent is doing.** While a run goes, the thread's
  status, at the bottom of the thread with the app's icon and a spinner, says
  what the agent is doing now: "Running `pnpm test`", "Searching the web for
  …", "Editing bridge.ts", or "Thinking…" between steps. It is the status
  Office and Devin show (`assistant.threads.setStatus`), read from T3's
  `t3_thread_read` activity view every 2.5 seconds, at most 50 characters,
  with anything that looks like a secret redacted. The agent session
  (`agents.sessions.setStatus`) is `suspended` while T3 waits on a person and
  `active` otherwise. The bridge never sets `processing`: Slack draws a "Stop"
  pill in its place and hides the status text. Both are sent again every 90
  seconds.
- **Answers are normal replies.** When a run ends, its final message is posted
  to the thread in parts of up to 12,000 characters, Slack's limit. A run that
  ends without a final message, or whose whole final message is `NO_REPLY`,
  posts nothing. The marker exists because Claude Code asks a run that ends
  with no text for a visible reply. Every chat's first turn, and the chat
  tools' standing instructions, also tell the agent that a subagent or
  background command can wake it more than once: a wake that only repeats a
  result already posted, or only says the work is still going, gets `NO_REPLY`. On Linear, a quiet run
  whose session still shows the agent at work ends it with a short "Done, nothing to add." response,
  unless another answer is still owed there. A failed run posts a short notice.
- **Questions come to Slack.** When the agent asks a question, the bridge posts
  it in the thread with a button for each option, and Submit for a multiple
  choice. Where the question takes free text, a reply in the thread answers it
  instead of starting a new turn. The answer goes back through
  `t3_pending_request` (or `t3_pending_request_respond` on T3 servers from
  before the per-action tools were merged), so the same run carries on, and
  the question then shows what was picked. Codex's question ends its run and
  T3 hands the answer to a new run; the bridge looks for that run after
  answering and posts its reply like any other. Only people in `allowedUserIds` can answer.
- **Permissions can't be granted from Slack.** T3's tools can't approve a
  permission request, so a run that asks for one is stopped, and the thread
  says why. Threads start in `full-access` mode, so this is rare.
- **Model switch.** As in Office, `!opus`, `!fable`, `!glm`, `!sol`, `!astra`
  or `!terra` anywhere in a message picks the model, with an optional effort
  (`!sol-high`, `!opus-low`); an effort alone (`!high`) keeps the model. The
  first one outside code is taken out of the message. GPT models run on
  Codex and the rest on Claude, and a thread can change provider between
  turns (`t3_thread_configure`). A switch with nothing else confirms it in
  the thread. New threads start on `modelSelection` from the config.
- **Results that arrive later.** When a run ends while its subagents or
  background work are still going, the bridge keeps following the thread
  (`t3_thread_wait` with `untilDelegatedWorkSettled`, for up to six hours).
  Each run T3 starts when that work reports back begins with a notification,
  and its answer is posted like any other, once. The follow is saved, so a
  restart picks it up where it left off. If six hours pass with the work
  still going, the bridge stops following and says so in the chat. A run
  started by a message typed in T3 stays in T3.
- **Status from the agent.** The `chat_status` tool sets the status text, such
  as "Running the tests", until the agent's next step.
- **Titles follow T3.** A new T3 thread starts with a short title: the
  request's first sentence, without tags such as `[t3 bridge test]` or
  mentions, at most 60 characters. The bridge then asks T3 to write a summary
  title (`t3_thread_update` with `regenerate_title`), which needs T3's title
  generation to work. The Slack thread takes the T3 title, in DMs and channel
  threads alike, and again whenever T3 renames it (`agents.sessions.rename`
  with `channel_id` and `thread_ts`). Slack refuses some characters, such as
  square brackets, so the bridge leaves them out. A rename Slack refuses is
  tried again on later checks, up to three times per title. The T3 title is
  the only source: renaming the thread in Slack doesn't rename the T3 thread,
  and Slack takes the T3 title again the next time T3 changes it.
- **Stop.** `@bot stop` in a thread interrupts its T3 run
  (`t3_thread_interrupt`), and the thread says "The run was stopped." Slack's own stop
  button (`agent_session_stopped`) does the same where Slack shows it. Only
  people in `allowedUserIds` can stop a run.
- **Nothing is lost.** Each Slack message is saved to an inbox table in SQLite
  before the bridge acts on it, and each Slack thread's messages are handled
  from that table in order. If T3 can't take a message, it stays in the inbox
  and is retried after 15 s, 30 s, 1 min and so on, up to 10 min apart. After
  nine failed tries (about 36 minutes) the bridge says so in the thread and
  drops it. Later messages in that thread wait behind it. T3 retry keys make a
  retried message land once.
- **Restarts are safe.** After a restart the bridge works through what is left
  in the inbox and picks up runs it still owes a reply for. Then it reads Slack
  for messages sent while it was down: replies in threads bound in the last 14
  days (up to 200 threads), new mentions in mapped channels, and new messages
  in direct-message channels it has answered before. It reads from a minute
  before it last ran, and skips messages it already has.

Who can use it is set in the config, in one of two ways:

- **An allowlist (the default).** Only Slack users in `allowedUserIds` can use
  it.
- **Everyone in the workspace.** With `"allowEveryone": true`, every full
  member of the workspace can use it as well. People in `allowedUserIds`
  still can. Guests, bots, deactivated accounts and people from other
  companies in shared channels can't. The bridge checks each person with
  `users.info` (their team, `is_restricted`, `is_ultra_restricted`) and
  remembers the answer for ten minutes. A failed check counts as not allowed.

  Every run has the bridge's T3 access. With a `full-access` runtime mode,
  anyone in the workspace can then run commands on the machine as the user
  T3 runs as. The bridge logs a warning at start-up while this is on. Use it
  with a project and a runtime mode that you would hand to everyone.

The same rule covers starting a thread, follow-ups, answering a question and
stopping a run. Anyone not allowed who mentions or messages the bot gets a
short reply, at most once an hour, with their member id to add. Messages from
bots, including itself, are ignored.

## Threads that start their own conversation

A T3 thread can start a conversation itself instead of waiting for one:

- `slack_start` posts an opening message as a new top-level message in any
  channel the bot is in, or as a DM when `channel` is a person's member id
  (`chat.postMessage` takes a user id, so this needs only `chat:write`). The
  Slack thread under that message is bound to the T3 thread: replies there
  continue it, and its final message in each run posts there. In a DM, reply
  in the thread under the bot's message.
- `linear_start` does the same with a Linear issue (see Linear below).

Both take the thread's own id or a subagent's `childThreadId`, and need no
chat key. Stock T3 never tells the bridge which thread is calling, so the
bridge can't prove the caller is that thread; the tools are served on
loopback only, to agents on this host, as the other chat tools are.

## How the agent posts files and reactions

Stock T3 doesn't tell an MCP server which thread is calling it, so the bridge
writes a random chat key for each Slack thread into the turn it sends. The
agent passes that key to `chat_post`, `chat_react` or `chat_status`. The key is the permission:
it only reaches its own Slack thread, and `chat_post` only reads files inside
that thread's worktree or project folder.

The tools are served on `http://127.0.0.1:<toolsPort>/mcp`, on loopback only.
The server also sends the agent short instructions when it connects: that its
final message goes to Slack, and how to mention people. Those stay in view after
the first turn is compacted away. Every later turn repeats the chat key.
Each agent provider must be told about that server (step 5).

## Setup

You need Node 24 or later (for `node:sqlite` and running TypeScript directly),
a T3 Code server, and permission to create a Slack app in your workspace.

### 1. Install

From the repository root:

```sh
pnpm install
cd apps/chat-bridge
```

### 2. Create the Slack app

Print a manifest and create the app from it at
<https://api.slack.com/apps> → **Create New App** → **From a manifest**:

```sh
node src/bin.ts manifest --name "T3 Code"
```

The manifest turns on Socket Mode and asks for these bot scopes:
`app_mentions:read`, `assistant:write`, `channels:history`, `groups:history`,
`im:history`, `chat:write`, `files:read`, `files:write`, `reactions:write` and
`users:read`. It turns on Slack's agent features (`agent_view` and agent
tasks), the Messages tab so people can send it direct messages, and
interactivity for the answer buttons. It subscribes to
`agent_session_stopped` (the stop button) and `app_context_changed` (logged, nothing else) as well as messages and mentions.

Then:

- Install the app to your workspace and copy the **Bot User OAuth Token**
  (`xoxb-…`). This is `SLACK_BOT_TOKEN`.
- Under **Basic Information → App-Level Tokens**, create a token with the
  `connections:write` scope (`xapp-…`). This is `SLACK_APP_TOKEN`.
- Invite the bot to each channel you want to use (`/invite @T3 Code`).

### 3. Write the config

The bridge keeps its files in `~/.t3-chat-bridge`, or in `$T3_CHAT_BRIDGE_HOME`
when that is set. Create `config.json` there:

```json
{
  "t3Url": "http://127.0.0.1:3773",
  "channelProjects": [{ "channelId": "C0123ABCD", "projectId": "your-t3-project-id" }],
  "dmProjectId": "your-t3-project-id",
  "allowedUserIds": ["U0123ABCD"],
  "toolsPort": 3920,
  "runtimeMode": "full-access",
  "modelSelection": { "instanceId": "claudeAgent", "model": "claude-opus-5-5" }
}
```

- `t3Url`: your T3 server's address.
- `t3EnvironmentId`: optional. Checks that `t3Url` serves this environment,
  then pins thread, project, and pending-request calls to it. Without it,
  T3 uses the connected server's local environment. Use the ID from
  `t3_environment_read`, not an Office worker registration name. All channels
  on one bridge use this target. Linked remote environments are not supported;
  attachment tools operate on the connected server.
- `channelProjects`: which T3 project a mention in each channel starts its
  thread in. A channel id is in the channel's **About** panel. A project id is
  in T3, or from the `t3_project_list` MCP tool. A channel can have several
  entries; the first that matches wins. Optional fields per entry:
  - `match`: only messages containing this text, in any case, such as
    `[nextcard]`. An entry without it takes every message.
  - `worktreeFrom`: start each thread in a new worktree from this branch on
    origin, such as `dev`, instead of the project's own checkout.
  - `note`: text added to the thread's first turn, such as limits on what the
    agent may run.
- `dmProjectId`: optional. The T3 project direct messages start their threads
  in. Without it, direct messages are ignored.
- `allowedUserIds`: Slack member ids (profile → **⋯** → **Copy member ID**). Can be
  empty when `allowEveryone` is on.
- `allowEveryone`: optional, `false` by default. `true` also lets every full
  member of the workspace use the bot (see above).
- `toolsPort`: the port for the `chat_post` / `chat_react` server. Default 3920.
- `runtimeMode` and `modelSelection`: optional, for new threads. Without them
  T3 uses the project's defaults. T3 caps the runtime mode at the access you
  grant the bridge in step 4.

Pass `--config PATH` to `start` to use a config file somewhere else.

### 4. Sign in to T3

```sh
node src/bin.ts login --t3-url http://127.0.0.1:3773
```

It prints a link. Open it in a browser signed in to T3, choose the access level,
and approve. The bridge listens on `127.0.0.1:3921` for the redirect
(`--callback-port` changes it) and saves the token to `t3-login.json` with mode 0600. The login lasts 30 days. Run `login` again when it expires.

The bridge can only start threads at the access level you approve. Agents that
must edit files or run commands unattended need `full-access` or `auto`.

To use a token you already have instead, set `T3_TOKEN` when you run `start`.

### 5. Give the agents the chat tools

Register `http://127.0.0.1:3920/mcp` (your `toolsPort`) as an HTTP MCP server
named `t3-chat-bridge` for each agent provider T3 runs.

Claude, for every project:

```sh
claude mcp add --scope user --transport http t3-chat-bridge http://127.0.0.1:3920/mcp
```

Or for one project, in its `.mcp.json`:

```json
{ "mcpServers": { "t3-chat-bridge": { "type": "http", "url": "http://127.0.0.1:3920/mcp" } } }
```

Claude asks before using a project server. To skip the prompt, add
`"enableAllProjectMcpServers": true` to that project's `.claude/settings.json`.

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.t3-chat-bridge]
url = "http://127.0.0.1:3920/mcp"
```

Or, to give the tools only to Codex runs that T3 starts, set the Codex
provider's **Launch arguments** in T3's settings to:

```text
-c mcp_servers.t3-chat-bridge.url="http://127.0.0.1:3920/mcp"
```

T3 runs one Codex app-server per provider instance and doesn't restart it when
settings change, so restart T3 afterwards.

Without this step the bridge still works, but agents can't send files or react.

### 6. Start it

```sh
SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… node src/bin.ts start
```

It checks that each mapped project exists, connects to Slack, and logs to
stderr. Keep it running under your process manager of choice (systemd, launchd,
pm2). Stop it with Ctrl-C or SIGTERM.

Run one bridge per Slack app. Two processes on the same app token would split
Slack's events between them.

## How platforms plug in

Slack, iMessage, and Linear share one Chat SDK `Chat` (`src/chatHost.ts`).
Office subscribes directly to its Convex inbox. Both paths feed the same
`Bridge.receive`, which saves messages to SQLite before handing them to T3.

The bridge core (`src/bridge.ts`) does everything about T3: bindings, the
inbox, runs, questions, model switches and access. It reaches a platform only
through `ChatPlatform` (`src/platform.ts`), which carries what the SDK doesn't
model:

- who may use it: an allowlist, and `allowEveryone`;
- where a new conversation starts its thread: a project, and optionally a new
  worktree and a note;
- how a person, a message and the reply rules read to the agent;
- optional extras: Slack's agent session status, titles and Block Kit
  questions. A platform without buttons gets questions as numbered text, and
  people answer by replying with a number, an option or their own words.

A platform uses a Chat SDK adapter where one fits, or its own subscription,
to turn incoming messages into `InboundEvent`s. Its `ChatPlatform` sends
the core's replies and status back.

## Office

Set `OFFICE_CONVEX_URL`, `OFFICE_CHAT_BRIDGE_TOKEN`, and `OFFICE_T3_PROJECT_ID`
in the bridge's environment. Article chats run Office's article tool
(`apps/office/scripts/article-workspace.cts`) from a nextcard checkout with its
packages installed: `OFFICE_REPOSITORY_PATH`, or the project's checkout when
it isn't set.
`OFFICE_WORKTREE_FROM` optionally starts new threads in worktrees from that
branch. The bridge removes the service token from its environment after
reading it. The old `OFFICE_AGENT_SERVICE_TOKEN` is no longer used.

Office's `chatBridge:prepare` checks access before delivery. One Office chat
maps to one T3 thread. New threads get Office's mode instructions and the
requester's commit trailer. Known Office model names map to T3 models;
unknown names use the configured default. An existing, readable legacy
thread is reused without posting its old answer.

The channel subscribes to `chatBridge:inbox` with the Convex client; it does
not poll. Once the core accepts an event into SQLite, the channel acknowledges
it in Office. Redelivery after a lost acknowledgement does not start another
turn. The core follows runs and posts answers, questions, uploaded files,
finished steps, plans, state, and titles. `NO_REPLY` clears the working state
without posting a message. A stop interrupts the chat's current run.

Article credentials live in mode-0600 connection files under
`$T3_CHAT_BRIDGE_HOME/office-article`, never in the prompt or SQLite inbox.
The agent gets a launcher for nextcard's `apps/office/scripts/article-workspace.cts`
and a local snapshot when Office supplies one. Connection files are removed
when their run ends or their token expires. A bridge restart preserves
connections for running agents and restores expiry timers before resuming runs.
Snapshots and edit files remain for inspection.

Support cases have an Office chat and a Slack thread, bound to one T3 thread
with `sync: true`. The channel opens and links the Slack thread when needed,
then receives the request on the Office key. A staff reply in Slack appears
in Office with its author; agent replies, questions, steps, plans, and state
appear in both. Slack staff messages still use the Slack allowlist. Without
Slack, the request is rejected with a visible error in Office.

Binding groups default to `sync: false`. In an unsynced group, replies go to
the conversation that sent the request; delegated-work wakes go to the
conversation used last. Existing bindings migrate into one-conversation,
unsynced groups. Linking is host-controlled, with no user-facing linking tool.

This v1 keeps the core's existing delivery guarantees and forty-step limit.
It does not add a durable output outbox, execution-specific stop fences,
history import. Posts have stable reply identities
for Office's deduplication. An upload retried before the post succeeds can
leave an unused storage object.

## Cutover from office-t3-worker

`import-office` reads every page of `chatBridge:legacyBindings` with the
Office service token. It checks each T3 thread before importing it. It never
sends a T3 message, subscribes to Office's inbox, connects to Slack, or owes
an answer from an earlier run.

The import adopts these destinations:

- `slack`: the Slack key only. The Office chat remains history.
- `support`: the Office key and Slack key, with group sync enabled.
- `office`: the Office key. A later `prepare` can also adopt it lazily.

Slack subscriptions are local Chat SDK state in the same database. They let
staff replies in the old Slack threads reach the bridge after it starts.
Importing does not post anything to those threads.

### Target the shared T3 server

The bridge connects to `<t3Url>/mcp` with an MCP bearer token. It does not
start a T3 server. On the cutover host, these values were verified read-only
on November 6, 2026:

```json
{
  "t3Url": "http://127.0.0.1:3778",
  "t3EnvironmentId": "ca333224-0a70-495a-b0e1-419928d47e9c",
  "channelProjects": [],
  "allowedUserIds": [],
  "runtimeMode": "full-access"
}
```

The old worker uses that server through native RPC, with a different
credential type. Do not copy its `T3_BEARER_TOKEN` into `T3_TOKEN`. Use
`login --t3-url http://127.0.0.1:3778` to approve an MCP login at the access
level the bridge needs. The login is bound to the server's origin. A login
for the rehearsal server on port 3911 cannot authenticate to port 3778.
An existing MCP credential may instead come from `T3_TOKEN`.

Office needs these non-secret settings in the bridge's environment:

```sh
export OFFICE_T3_PROJECT_ID=1bac8beb-ae3c-4fb4-ad4e-24bd3186525f
export OFFICE_REPOSITORY_PATH=/home/vivek-affil/nextcard
export OFFICE_WORKTREE_FROM=dev
```

That project is the worker's registered `/home/vivek-affil/office` project,
not the primary nextcard checkout's project. Keep using it for Office
threads. `OFFICE_REPOSITORY_PATH` points to an installed nextcard checkout
containing the cutover version of `apps/office/scripts/article-workspace.cts`;
update that checkout before enabling article chats. It does not change the
T3 project's workspace. `OFFICE_WORKTREE_FROM=dev` preserves the worker's
default of creating worktrees for new conversations.

Set `OFFICE_CONVEX_URL` to the intended Office deployment and supply
`OFFICE_CHAT_BRIDGE_TOKEN` through the owning environment's secret manager.
The importer needs only these two Office settings; it reads each imported
thread's project from T3. Exported `environmentId` values are historical
metadata, not routing instructions. In particular, the worker registered
as `dev-affil-server-t3`; that is not the shared server's MCP environment ID.
Thread existence on the configured T3 target is authoritative.

The minimal config above enables no Slack access by itself. Before starting
the bridge, restore the intended Slack allowlist and channel routes using
project IDs on the shared server, and supply the production Slack app
credentials. Check every other enabled channel's routes too. Do not reuse
the scratch server's project IDs, MCP login, or binding database.

### Import with the bridge stopped

Run these commands from `apps/chat-bridge`. The cutover owner first drains
the legacy worker and stops it as part of the production cutover. Then stop
the bridge with `systemctl --user stop t3-chat-bridge.service` and keep it
stopped through import and verification. Concurrent import and bridge
execution against the same home are not supported. A rehearsal in a fresh
scratch home does not require stopping either live service.
Do not change the shared T3 service or its configuration.

1. Choose the production bridge home and write its `config.json`. For a
   rehearsal, use a fresh `mktemp -d` directory. Never use the running
   `.scratch/bridge-home-native` home for a rehearsal.

   ```sh
   export T3_CHAT_BRIDGE_HOME=/path/to/cutover-bridge-home
   node src/bin.ts login --t3-url http://127.0.0.1:3778
   ```

2. If this home already has a database, checkpoint it after stopping the
   bridge. A dry-run refuses a nonempty WAL because an immutable read would
   miss its uncheckpointed changes.

   ```sh
   sqlite3 "$T3_CHAT_BRIDGE_HOME/bridge.db" 'PRAGMA wal_checkpoint(TRUNCATE);'
   ```

3. Preview the import with the Office credentials injected through
   Infisical. This command does not create a bridge home or write database
   files. `imported` counts rows that would change, not writes performed.

   ```sh
   agent-env office prod -- node src/bin.ts import-office --dry-run
   ```

4. Resolve unexpected `thread_not_found` skips or conflicts before proceeding.
   A scratch-server URL is a common cause of missing legacy threads. Then
   import and rerun:

   ```sh
   agent-env office prod -- node src/bin.ts import-office
   agent-env office prod -- node src/bin.ts import-office
   ```

Each command prints one JSON result per exported row and a final summary
with `imported`, `unchanged`, `skipped` by reason, and `conflicts`.
Counts are per export row, so a support pair counts once. The summary also
includes Office's per-page skip counts, including empty pages. A rerun
reports zero imports once all bindings, sync flags, and subscriptions exist.
A repair of a missing subscription or support sync flag counts as imported.

A key bound to another T3 thread is a conflict. The importer leaves the
whole row alone, including both destinations of a support case. It never
replaces a key, disables an existing sync flag, or changes a chat key.
Auth, network, and other T3 failures abort the command instead of becoming
missing-thread skips. Each row commits atomically, so a failed command can
be rerun after fixing its cause.

### Verify the store before starting the bridge

Read bindings and subscriptions without selecting the private `chat_key`.
For strict no-file-write reads, use the same immutable mode after checkpointing:

```sh
sqlite3 -readonly "file:$T3_CHAT_BRIDGE_HOME/bridge.db?immutable=1" '
  SELECT b.chat_thread_key, b.thread_id, b.project_id, g.sync,
         CASE WHEN s.thread_id IS NULL THEN 0 ELSE 1 END AS subscribed
  FROM binding b
  JOIN binding_group g ON g.thread_id = b.thread_id
  LEFT JOIN state_subscription s ON s.thread_id = b.chat_thread_key
  ORDER BY b.thread_id, b.chat_thread_key;
  SELECT COUNT(*) AS owed FROM owed_reply;
  SELECT COUNT(*) AS following FROM delegated_follow;
  SELECT COUNT(*) AS inbox FROM inbox;
'
```

Each imported Slack key has `subscribed=1`. Each support pair shares a
thread and has `sync=1`. Ordinary Slack rows have no new Office key. The
import adds nothing to `owed_reply`, `delegated_follow`, or `inbox`, even
when a legacy thread has a completed or running answer.

Start the bridge only after the cutover owner has switched Office's producers
and confirmed that the legacy worker is stopped. A subsequent authorized
staff reply in an imported Slack thread must continue the existing T3
thread. For support, confirm that the new exchange appears in both places.
This live check is separate from the read-only import rehearsal.

## iMessage

The agent answers iMessages sent to a Mac's Messages account. Today that's
iMessage only; SMS may come later. `imessage.services` lists the services
that are read (default `["iMessage"]`), and chats on any other service are
left alone. Each conversation is one ongoing T3 thread, and group chats are
allowed. In a group, every message goes to the agent, which decides whether to
answer. Photos and files arrive as attachments, and iPhone HEIC photos become
JPEG. The agent sends files, such as images and PDFs, with `chat_post`. The
text goes out with the first file, and a send `imsg` can't confirm isn't
retried, so nothing arrives twice. Answers are sent as plain text.

Reactions work the same way on every platform. A reaction never starts a run.
In a bound thread, a reaction from someone allowed (an iMessage tapback or a
Slack reaction) is kept as context for the thread's next turn, such as
"Vivek reacted love (heart) to message <id>", and removals are kept too.
Slack reactions reach the bridge only if the Slack app subscribes to
`reaction_added` and `reaction_removed`.

How it connects:

- **On the Mac.** `mac/affil-imessage.swift` runs a pinned, reviewed `imsg`
  (v0.20.0) and serves a limited set of its JSON-RPC methods on
  `127.0.0.1:47821`. It watches every chat from the moment `imsg` starts and
  subscribes again whenever `imsg` restarts or falls behind. It also stages
  outgoing files and reads incoming ones, but only from the Messages
  attachments folder. macOS grants Full Disk Access and Automation to this
  service, and `imsg`, its child, inherits them. Sign it with a stable
  identity, not ad hoc, so a rebuild keeps the grants. It serves one client
  at a time, and a new connection replaces the old one, so don't probe it
  while the bridge is connected.
- **On the bridge's host.** An SSH tunnel carries that port. The adapter
  connects through it and reconnects by itself. After a reconnect it catches
  up from its saved Messages row id with `messages.after`.

Config, in `config.json`:

```json
"imessage": {
  "host": "127.0.0.1",
  "port": 47821,
  "projectId": "<T3 project id>",
  "worktreeFrom": "dev",
  "allowEveryone": false,
  "allowedHandles": ["+14155550100", "someone@example.com"],
  "outboundReactions": false
}
```

`worktreeFrom` and `note` are optional, as in `channelProjects`.
`allowEveryone: true` lets anyone who messages the account start runs, and the
bridge logs a warning when it starts with it on. `startAfterRowId` also
answers messages already waiting on the very first start.

### Always on

Every piece starts by itself and comes back by itself. Nobody starts anything
by hand. Only macOS permission prompts need a person.

- **Mac:** a LaunchAgent in the Messages user's login session
  (`mac/com.affil.imessage.plist`: `RunAtLoad`, `KeepAlive`). The Mac stays
  awake and logged in to that user.
- **Bridge host:** systemd user units with `Restart=always`, enabled with
  lingering, so they start at boot: the SSH tunnel (`ssh -N -L
  127.0.0.1:47821:127.0.0.1:47821 …` with `ExitOnForwardFailure` and
  keepalives), the bridge, and the T3 server it talks to.

Checked on 2026-11-04 by killing each piece in turn: the bridge, the tunnel,
the T3 server and the Mac service each came back without help, and the bridge
reconnected to each.

### What iMessage can't do without SIP off

`imsg` sends tapbacks, typing bubbles and read receipts, and edits and unsends
messages, only through Apple's private Messages framework. It reaches that
framework by injecting a helper into Messages, which needs SIP turned off on
the Mac. Until then the agent isn't offered `chat_react` in iMessage, there's
no "typing" while a run works, and messages show as delivered, not read.

`imsg react` can send the six standard tapbacks without SIP, by driving
Messages' Tapback picker with UI scripting. The bridge doesn't use it:

- it reacts to the last or selected message, not one picked by id;
- it needs Messages frontmost in the active GUI session, and the bridge's Mac
  user runs in the background while someone else uses the Mac;
- it needs an Accessibility grant, and a timeout leaves it unknown whether the
  tapback was sent.

**Outbound tapbacks with SIP off.** Set `imessage.outboundReactions: true`.
On each connect the adapter asks `imsg` for `status`. It turns tapbacks on
only when imsg's private bridge is running and offers `tapback`, and logs
which way it went. Otherwise `chat_react` fails with a clear message, and the
agent is told not to use it. Tapbacks target a message by its guid. They come
in six kinds: heart, thumbsup, thumbsdown, laugh, bangbang and question.

Turning SIP off on an Apple Silicon Mac (imsg needs only `csrutil disable`;
it documents no boot arguments):

1. Apple menu → Shut Down, and wait until the Mac is fully off.
2. Press and hold the power button until "Loading startup options" appears.
   Click Options, then Continue.
3. If asked, choose an administrator account and enter its password.
4. In the menu bar, choose Utilities → Terminal.
5. Run `csrutil disable`, answer `y`, and enter an administrator's name and
   password when asked.
6. Run `csrutil status`. It should say "System Integrity Protection status:
   disabled."
7. Apple menu → Restart, then log back in to the Mac user that runs Messages
   for the bridge.

Then, as that user, with no further clicks: run `imsg launch --install-agent`,
which injects the helper into Messages and keeps it injected across restarts.
Check that `imsg status` shows the bridge running. Then set
`outboundReactions: true` and restart the bridge. On macOS 26 and later,
library validation or Messages' private entitlement checks can still block the
helper with SIP off; `imsg status` says so if they do.

To undo: run `imsg launch --uninstall-agent`, set `outboundReactions: false`,
then in Recovery run `csrutil enable` and restart. SIP off lowers the
security of the whole Mac, not only Messages.

## Linear

The agent works in Linear as an app (`@chat-adapter/linear` in agent-sessions
mode, on Linear's Agents API), so it shows natively:

- **What starts a run:** an agent session. Mentioning the app in a comment
  (`@office …`) starts one, and so does delegating or assigning an issue to
  it. Plain comments that don't mention the app start nothing; on an issue
  the agent already works on, they are kept as context for its next run and
  never answered. That needs the app's Comments webhook event. A comment
  waits 15 s first, so a session prompt made from the same comment counts
  instead.
- **One T3 thread per issue.** Every session on an issue continues the
  issue's thread, so a new `@office` mention picks up where the last session
  left off. Prompts in any of its sessions follow up there and steer a run in
  flight. Each answer goes to the session the latest prompt came from.
- **What shows in Linear:** a "thought" as soon as a session gets a prompt
  (Linear marks a session unresponsive after a few seconds without one), the
  run's status as thoughts, an "action" for each finished step (such as "Ran
  `pnpm test`", with no output), and the final message as the response, in
  Markdown. Only the answer is a response; a question is an elicitation.
- **What the agent gets:** the prompt, plus Linear's context for a new
  session (the issue, its description and comments). Images and files in a
  prompt are downloaded with the bridge's token and arrive as files, HEIC as
  JPEG (named `.jpg` in the prompt too); their signed links never reach the agent. A prompt whose webhook was
  lost is handed over with the next one.
- **Files:** the agent sends files with `chat_post`. They are uploaded to
  Linear and linked in the response, and images show inline. Linear shows no
  reactions on session messages, so `chat_react` adds none and tells the
  agent to acknowledge in words instead.
- **Questions:** a single-choice question shows Linear's own chooser (an
  elicitation with the `select` signal); a pick comes back as a prompt with
  the option's label. Multiple choice, or a chooser Linear refuses, is
  numbered text. Either way a typed reply answers too.
- **Plan:** the agent's to-do list shows as the session's plan, replaced whole
  as steps start and finish.
- **Stop:** the session menu's "Send stop request" interrupts the run. The
  bridge checks Linear's signature before acting, and the stopped run's last
  word is "The run was stopped." (or "Nothing was running.").
- **Work a T3 thread starts:** any T3 thread can take its work to Linear
  with `linear_start`: its own thread id (stock `orchestrator_capabilities`
  returns it as `parentThreadId`), or a subagent's `childThreadId` from
  `delegate_task`, plus an issue (`AFF-123`) or a new one (`newIssue: {team,
  title, description}`). The bridge opens an agent session on the issue and
  binds the issue to that thread, so its progress and final message show in
  Linear and later prompts on the issue continue it. The answer of the run in
  flight posts once, whether it ends before or after the call. A thread
  answers one conversation, and an issue that already goes to another thread
  needs `replace: true`. A subagent stays under its orchestrator in T3, and
  its completion still wakes the orchestrator; later Linear prompts don't.
- **Routing:** by the issue's team. `teams` lists a project, and optionally a
  new worktree and a note, per team key; every other team takes the default
  route.
- **Access:** everyone in the workspace who can mention the app, unless
  `allowEveryone` is false; then only `allowedUserIds` (Linear user ids).

```json
"linear": {
  "botName": "office",
  "webhookPort": 3930,
  "webhookPath": "/linear/webhook",
  "projectId": "<default T3 project id>",
  "worktreeFrom": "dev",
  "teams": [{ "team": "ENG", "projectId": "<T3 project id>", "worktreeFrom": "dev" }]
}
```

Secrets come from the environment, never the config: `LINEAR_CLIENT_ID`,
`LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET`. The bridge reads them and
removes them from its environment, so the adapter's own auto-detection can't
pick them up. Without all three, Linear stays off and its webhook answers 503. The app authenticates with client credentials as itself, with scopes
`read`, `write`, `comments:create`, `issues:create`, `app:mentionable` and
`app:assignable`, so there is no OAuth callback to host.

### Webhook ingress

The bridge serves webhooks on loopback only
(`127.0.0.1:<webhookPort><webhookPath>`). It answers POST at exactly that
path and 404 everywhere else, and the adapter checks Linear's signature and
timestamp on every request. Public HTTPS is a separate, swappable piece that
forwards only that path:

- **Tailscale Funnel** (in use). Funnel opens a whole port, and port 443 on
  this host already serves tailnet-only paths, so Linear gets 8443. This
  host's Serve config has path and socket handlers, so any change needs root.
  Once, as root:

  ```sh
  sudo tailscale funnel --bg --https=8443 --set-path=/linear/webhook \
    http://127.0.0.1:3930/linear/webhook
  ```

  `--bg` keeps it across reboots and restarts of `tailscaled`. Check it with
  `tailscale funnel status`; only `:8443` should say "Funnel on". The URL
  Linear calls is `https://<host>.<tailnet>.ts.net:8443/linear/webhook`.
  To undo: `sudo tailscale funnel --https=8443 --set-path=/linear/webhook off`.

- **Cloudflare tunnel** (alternative). Add one ingress rule with
  `path: ^/linear/webhook$` and service `http://127.0.0.1:3930`, followed by
  the catch-all `http_status:404`.

## Limits

- The bridge, T3 and the agents must share a machine. `chat_post` reads files
  by path, and the tools server listens on loopback.
- Catch-up after downtime misses a mention inside a thread the bot wasn't in,
  and a first direct message from someone the bot has never answered.
- T3 issues no refresh tokens, so the login needs renewing every 30 days.
- Answers are posted up to 50,000 characters, in parts of up to 12,000.
- A T3 message takes at most 8 attachments, so a mention with more files (its
  own plus the thread's) imports the first 8 and names the rest.
- If Slack refuses an answer five times in a row, the bridge stops trying until
  it restarts.

## Development

```sh
pnpm --filter @t3tools/chat-bridge typecheck
pnpm --filter @t3tools/chat-bridge test
```

| File                   | What it does                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/bin.ts`           | The `start`, `login`, `manifest`, and `import-office` commands.                                                        |
| `src/bridge.ts`        | The core: chat messages into T3 turns, each run watched, answers back.                                                 |
| `src/platform.ts`      | `ChatPlatform`: what the core needs from a platform beyond the SDK.                                                    |
| `src/chatHost.ts`      | The one Chat SDK `Chat`, with an adapter per platform.                                                                 |
| `src/slack/`           | Slack: the adapter's messages and Slack-only calls (`host.ts`), its `ChatPlatform`, text helpers and the app manifest. |
| `src/linear/`          | Linear: agent sessions as `InboundEvent`s, file uploads, and its `ChatPlatform`.                                       |
| `src/office/`          | Office: Convex inbox, presentation API, requester context, and expiring article connections.                           |
| `src/webhookServer.ts` | Loopback webhooks for platforms that need them, at exact paths only.                                                   |
| `src/imessage/`        | iMessage: the Chat SDK adapter, its RPC client and its `ChatPlatform`.                                                 |
| `mac/`                 | The Mac service and its LaunchAgent.                                                                                   |
| `src/runFeed.ts`       | What a run is doing now, from T3's activity view.                                                                      |
| `src/activity.ts`      | T3 activity items as status lines; redaction.                                                                          |
| `src/questions.ts`     | Agents' questions as buttons or numbered text, and their answers.                                                      |
| `src/threads.ts`       | The T3 MCP calls: launch, send, wait, read, configure.                                                                 |
| `src/t3Client.ts`      | The MCP client for T3.                                                                                                 |
| `src/toolServer.ts`    | The `chat_post` / `chat_react` MCP server.                                                                             |
| `src/store.ts`         | Inbox, bindings, handled messages and owed replies.                                                                    |
| `src/chatState.ts`     | The Chat SDK's state on the same SQLite file.                                                                          |
| `src/login.ts`         | T3's MCP OAuth sign-in.                                                                                                |
