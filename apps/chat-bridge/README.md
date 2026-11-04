# T3 chat bridge

Talk to T3 Code agents from Slack and iMessage, and later Linear. Mention the bot in a mapped channel and it
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
- **Replies continue it.** A reply in the Slack thread steers the run in flight,
  or starts a new run if the thread is idle. Set `followUpMode` to `queue` to
  run replies after the current run instead.
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
  ends without a final message posts nothing. A failed run posts a short
  notice.
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
  and its answer is posted like any other. A run started by a message typed
  in T3 stays in T3.
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
  "followUpMode": "steer",
  "toolsPort": 3920,
  "runtimeMode": "full-access",
  "modelSelection": { "instanceId": "claudeAgent", "model": "claude-opus-5-5" }
}
```

- `t3Url`: your T3 server's address.
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
- `followUpMode`: `steer` (default) or `queue`.
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

All platforms run on one Chat SDK `Chat` (`src/chatHost.ts`), one adapter
each: the official `@chat-adapter/slack`, and `src/imessage/adapter.ts`, a Chat
SDK adapter over `imsg`. The SDK does dedupe, thread locks, queueing,
subscriptions, Markdown and card fallback for all of them.

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

A new platform is a Chat SDK adapter (an official one where it exists, such as
`@chat-adapter/linear`), a `Deliver` that turns its SDK messages into
`InboundEvent`s, and a `ChatPlatform`.

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

| File                | What it does                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/bin.ts`        | The `start`, `login` and `manifest` commands.                                                                          |
| `src/bridge.ts`     | The core: chat messages into T3 turns, each run watched, answers back.                                                 |
| `src/platform.ts`   | `ChatPlatform`: what the core needs from a platform beyond the SDK.                                                    |
| `src/chatHost.ts`   | The one Chat SDK `Chat`, with an adapter per platform.                                                                 |
| `src/slack/`        | Slack: the adapter's messages and Slack-only calls (`host.ts`), its `ChatPlatform`, text helpers and the app manifest. |
| `src/imessage/`     | iMessage: the Chat SDK adapter, its RPC client and its `ChatPlatform`.                                                 |
| `mac/`              | The Mac service and its LaunchAgent.                                                                                   |
| `src/runFeed.ts`    | What a run is doing now, from T3's activity view.                                                                      |
| `src/activity.ts`   | T3 activity items as status lines; redaction.                                                                          |
| `src/questions.ts`  | Agents' questions as buttons or numbered text, and their answers.                                                      |
| `src/threads.ts`    | The T3 MCP calls: launch, send, wait, read, configure.                                                                 |
| `src/t3Client.ts`   | The MCP client for T3.                                                                                                 |
| `src/toolServer.ts` | The `chat_post` / `chat_react` MCP server.                                                                             |
| `src/store.ts`      | Inbox, bindings, handled messages and owed replies.                                                                    |
| `src/chatState.ts`  | The Chat SDK's state on the same SQLite file.                                                                          |
| `src/login.ts`      | T3's MCP OAuth sign-in.                                                                                                |
